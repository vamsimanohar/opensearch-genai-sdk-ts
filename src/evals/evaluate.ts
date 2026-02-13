/**
 * Evaluation orchestrator for OpenSearch AI observability.
 *
 * Runs a task function across a dataset, applies scorers to each output,
 * creates OTEL spans for the entire eval run, and stores scores in OpenSearch.
 */

import { trace, SpanStatusCode, Span } from "@opentelemetry/api";
import { Score, Scorer, adaptScore } from "./protocol.js";
import { score as submitScore } from "../score.js";

const TRACER_NAME = "opensearch-genai-sdk-evals";

/**
 * Result of a single data point evaluation.
 */
export interface EvalResult {
  /** The input given to the task. */
  input: unknown;
  /** The task's output. */
  output?: unknown;
  /** The expected output (if provided). */
  expected?: unknown;
  /** Dict of scorer name to Score. */
  scores: Record<string, Score>;
  /** Error message if the task failed. */
  error?: string;
}

/**
 * Summary of an evaluation run.
 */
export interface EvalSummary {
  /** The evaluation name. */
  name: string;
  /** Per-data-point results. */
  results: EvalResult[];
  /** Average score per scorer. */
  averages: Record<string, number>;
  /** Number of data points. */
  total: number;
  /** Number of failed data points. */
  errors: number;
}

/**
 * A single data point in the evaluation dataset.
 */
export interface EvalDatum {
  /** The input to the task. */
  input: unknown;
  /** The expected output (optional). */
  expected?: unknown;
  /** Allow additional fields. */
  [key: string]: unknown;
}

export interface EvaluateOptions {
  /** Name for this evaluation run. */
  name: string;
  /** List of dicts with "input" and optional "expected" keys, or a callable that returns such a list. */
  data: EvalDatum[] | (() => EvalDatum[]);
  /** Function that takes an input and returns output. Can be sync or async. */
  task: (input: unknown) => unknown | Promise<unknown>;
  /** List of scorer instances. */
  scores: Scorer[];
  /** Whether to emit scores as separate OTEL spans for Data Prepper routing. Defaults to true. */
  emitScores?: boolean;
}

/**
 * Format a span context ID as a hex string.
 */
function formatTraceId(traceId: string): string {
  return traceId;
}

function formatSpanId(spanId: string): string {
  return spanId;
}

/**
 * Run an evaluation: dataset -> task -> scorers -> OTEL spans.
 *
 * For each data point, runs the task function to produce output,
 * then applies all scorers. Creates OTEL spans for the entire flow.
 * Scores are emitted as OTEL spans through the same exporter pipeline.
 *
 * @example
 * ```ts
 * import { evaluate } from "@opensearch-project/genai-sdk";
 * import { Score } from "@opensearch-project/genai-sdk/evals";
 *
 * const exactMatch: Scorer = {
 *   name: "exact_match",
 *   score({ output, expected }) {
 *     const match = output.trim().toLowerCase() === (expected ?? "").trim().toLowerCase();
 *     return { name: "exact_match", value: match ? 1.0 : 0.0 };
 *   },
 * };
 *
 * const results = evaluate({
 *   name: "qa-eval",
 *   data: [
 *     { input: "Capital of France?", expected: "Paris" },
 *     { input: "2+2?", expected: "4" },
 *   ],
 *   task: (input) => myLlmCall(input as string),
 *   scores: [exactMatch],
 * });
 * ```
 */
export function evaluate(options: EvaluateOptions): EvalSummary {
  const { name, data, task, scores: scorers, emitScores = true } = options;

  const tracer = trace.getTracer(TRACER_NAME);

  // Resolve data if callable
  const dataset: EvalDatum[] = typeof data === "function" ? data() : data;

  const summary: EvalSummary = {
    name,
    results: [],
    averages: {},
    total: dataset.length,
    errors: 0,
  };

  tracer.startActiveSpan(
    "evaluate",
    {
      attributes: {
        "eval.name": name,
        "eval.dataset_size": dataset.length,
        "eval.scorer_count": scorers.length,
      },
    },
    (evalSpan: Span) => {
      for (let i = 0; i < dataset.length; i++) {
        const datum = dataset[i];
        const inputVal = datum.input;
        const expectedVal = datum.expected;

        const evalResult: EvalResult = {
          input: inputVal,
          expected: expectedVal,
          scores: {},
        };

        tracer.startActiveSpan(
          "eval_item",
          {
            attributes: {
              "eval.item.index": i,
              "eval.item.input": String(inputVal).slice(0, 1000),
            },
          },
          (itemSpan: Span) => {
            // Run the task
            let output: unknown;
            let taskFailed = false;

            tracer.startActiveSpan("eval_task", (taskSpan: Span) => {
              try {
                const result = task(inputVal);

                // Handle async tasks by noting we don't support them in sync evaluate()
                // For a sync evaluate, the task should be sync. Async tasks would need
                // an evaluateAsync() variant.
                if (result instanceof Promise) {
                  console.warn(
                    "[opensearch-genai-sdk] Async task detected in sync evaluate(). " +
                      "The promise will not be awaited. Use sync tasks or implement evaluateAsync().",
                  );
                }

                output = result;
                evalResult.output = output;
                taskSpan.setAttribute("eval.task.output", String(output).slice(0, 1000));
              } catch (err) {
                evalResult.error = String(err);
                summary.errors++;
                taskSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
                taskSpan.recordException(err as Error);
                taskFailed = true;
              }
              taskSpan.end();
            });

            if (!taskFailed) {
              // Run each scorer
              for (const scorer of scorers) {
                const scorerName = scorer.name;

                tracer.startActiveSpan(
                  `eval_score.${scorerName}`,
                  { attributes: { "eval.scorer.name": scorerName } },
                  (scoreSpan: Span) => {
                    try {
                      const rawResult = scorer.score({
                        input: String(inputVal),
                        output: String(output),
                        expected: expectedVal !== undefined ? String(expectedVal) : undefined,
                      });
                      const scoreObj = adaptScore(scorerName, rawResult);
                      evalResult.scores[scorerName] = scoreObj;

                      if (scoreObj.value !== undefined) {
                        scoreSpan.setAttribute("eval.score.value", scoreObj.value);
                      }
                      if (scoreObj.label) {
                        scoreSpan.setAttribute("eval.score.label", scoreObj.label);
                      }
                      if (scoreObj.rationale) {
                        scoreSpan.setAttribute(
                          "eval.score.rationale",
                          scoreObj.rationale.slice(0, 500),
                        );
                      }
                    } catch (err) {
                      console.warn(
                        `[opensearch-genai-sdk] Scorer ${scorerName} failed on item ${i}: ${err}`,
                      );
                      scoreSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
                      scoreSpan.recordException(err as Error);
                    }
                    scoreSpan.end();
                  },
                );
              }

              // Emit scores as OTEL spans
              if (emitScores) {
                const spanContext = itemSpan.spanContext();
                const traceIdHex = formatTraceId(spanContext.traceId);
                const spanIdHex = formatSpanId(spanContext.spanId);

                for (const [scorerName, scoreObj] of Object.entries(evalResult.scores)) {
                  try {
                    submitScore({
                      name: scorerName,
                      value: scoreObj.value,
                      traceId: traceIdHex,
                      spanId: spanIdHex,
                      label: scoreObj.label,
                      rationale: scoreObj.rationale,
                      source: "eval",
                      metadata: { eval_name: name, item_index: i },
                    });
                  } catch (err) {
                    console.warn(
                      `[opensearch-genai-sdk] Failed to emit score ${scorerName}: ${err}`,
                    );
                  }
                }
              }
            }

            summary.results.push(evalResult);
            itemSpan.end();
          },
        );
      }

      // Compute averages
      const scoreTotals: Record<string, number[]> = {};
      for (const result of summary.results) {
        for (const [scorerName, scoreObj] of Object.entries(result.scores)) {
          if (scoreObj.value !== undefined) {
            if (!scoreTotals[scorerName]) {
              scoreTotals[scorerName] = [];
            }
            scoreTotals[scorerName].push(scoreObj.value);
          }
        }
      }

      for (const [scorerName, values] of Object.entries(scoreTotals)) {
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        summary.averages[scorerName] = avg;
        evalSpan.setAttribute(`eval.avg.${scorerName}`, avg);
      }

      evalSpan.setAttribute("eval.errors", summary.errors);
      evalSpan.end();
    },
  );

  return summary;
}

/**
 * Format an EvalSummary as a human-readable string.
 */
export function formatEvalSummary(summary: EvalSummary): string {
  const parts = [`Eval: ${summary.name} (${summary.total} samples, ${summary.errors} errors)`];
  for (const [scorerName, avg] of Object.entries(summary.averages)) {
    parts.push(`  ${scorerName}: ${avg.toFixed(3)}`);
  }
  return parts.join("\n");
}
