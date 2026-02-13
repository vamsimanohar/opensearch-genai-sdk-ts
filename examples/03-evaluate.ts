/**
 * Evaluation with opensearch-genai-sdk.
 *
 * Shows how to run evaluate() with different scorer types:
 * - Custom scorers matching the Scorer interface
 * - Plain functions returning floats
 *
 * evaluate() creates OTEL spans for the entire flow and emits
 * scores through the same exporter pipeline.
 *
 * Run with: npx tsx examples/03-evaluate.ts
 */

import { register, evaluate, formatEvalSummary } from "../src/index.js";
import type { Score, Scorer } from "../src/index.js";

// --- Setup ---
register({ endpoint: "http://localhost:21890/opentelemetry/v1/traces" });

// --- Custom scorers ---

/** Scorer that checks if output exactly matches expected. */
const exactMatch: Scorer = {
  name: "exact_match",
  score({ output, expected }): Score {
    const match = output.trim().toLowerCase() === (expected ?? "").trim().toLowerCase();
    return {
      name: "exact_match",
      value: match ? 1.0 : 0.0,
      label: match ? "match" : "mismatch",
    };
  },
};

/** Scorer that checks if a keyword appears in the output. */
const containsKeyword: Scorer = {
  name: "contains_keyword",
  score({ output, expected }): Score {
    const keyword = (expected ?? "").trim().toLowerCase();
    const found = output.toLowerCase().includes(keyword);
    return {
      name: "contains_keyword",
      value: found ? 1.0 : 0.0,
      rationale: `Keyword '${keyword}' ${found ? "found" : "not found"} in output`,
    };
  },
};

// --- Dataset ---
const dataset = [
  { input: "What is the capital of France?", expected: "Paris" },
  { input: "What is 2 + 2?", expected: "4" },
  { input: "Who wrote Hamlet?", expected: "Shakespeare" },
];

// --- Task function (your LLM call goes here) ---
function myLlm(input: unknown): string {
  /** Replace with your actual LLM call. */
  const answers: Record<string, string> = {
    "What is the capital of France?": "Paris",
    "What is 2 + 2?": "4",
    "Who wrote Hamlet?": "William Shakespeare",
  };
  return answers[input as string] ?? "I don't know";
}

// --- Run evaluation ---
const results = evaluate({
  name: "qa-eval",
  data: dataset,
  task: myLlm,
  scores: [exactMatch, containsKeyword],
});
console.log(formatEvalSummary(results));
// Eval: qa-eval (3 samples, 0 errors)
//   exact_match: 0.667
//   contains_keyword: 1.000

// Span tree for each data point:
//
//   evaluate                       (eval run)
//   +-- eval_item [0]              (per data point)
//   |   +-- eval_task              (task execution)
//   |   +-- eval_score.exact_match (scorer)
//   |   +-- eval_score.contains_keyword
//   +-- eval_item [1]
//   |   +-- ...
//   +-- eval_item [2]
//       +-- ...
//
// Plus score.exact_match and score.contains_keyword spans
// emitted for each item (routed to ai-scores by Data Prepper)
