/**
 * Wrapper functions for tracing custom functions as OTEL spans.
 *
 * Provides traceWorkflow, traceTask, traceAgent, and traceTool
 * that create standard OpenTelemetry spans. These are the user-facing
 * API for tracing custom application logic -- the gap that pure
 * auto-instrumentors don't cover.
 *
 * All wrappers produce standard OTEL spans with gen_ai semantic
 * convention attributes. Zero lock-in: remove the wrapper and
 * your code still works.
 *
 * TypeScript does not have Python-style decorators that work on plain
 * functions, so we use higher-order wrapper functions instead:
 *
 * @example
 * ```ts
 * const search = traceTool("web_search", async (query: string) => {
 *   return [{ title: `Result: ${query}` }];
 * });
 *
 * const pipeline = traceWorkflow("qa_pipeline", async (question: string) => {
 *   const results = await search(question);
 *   return summarize(results);
 * });
 * ```
 */

import { trace, SpanStatusCode, Span } from "@opentelemetry/api";

/** Span kind values following OpenLLMetry/OTEL GenAI conventions. */
const SPAN_KIND_WORKFLOW = "workflow";
const SPAN_KIND_TASK = "task";
const SPAN_KIND_AGENT = "agent";
const SPAN_KIND_TOOL = "tool";

const TRACER_NAME = "opensearch-genai-sdk";

/** Maximum size (in characters) for serialized input/output attributes. */
const MAX_ATTRIBUTE_LENGTH = 10_000;

export interface TraceOptions {
  /** Optional version number for tracking changes. */
  version?: number;
}

/**
 * Trace a function as a workflow span.
 *
 * Use for top-level orchestration functions that coordinate
 * multiple tasks, agents, or tool calls.
 *
 * @param name - Span name for the workflow.
 * @param fn - The function to wrap.
 * @param options - Optional trace settings.
 * @returns A wrapped function with the same signature.
 *
 * @example
 * ```ts
 * const pipeline = traceWorkflow("qa_pipeline", async (question: string) => {
 *   const plan = await planSteps(question);
 *   return await execute(plan);
 * });
 * ```
 */
export function traceWorkflow<TArgs extends unknown[], TReturn>(
  name: string,
  fn: (...args: TArgs) => TReturn,
  options?: TraceOptions,
): (...args: TArgs) => TReturn {
  return makeWrapper(name, fn, SPAN_KIND_WORKFLOW, options);
}

/**
 * Trace a function as a task span.
 *
 * Use for individual units of work within a workflow.
 *
 * @param name - Span name for the task.
 * @param fn - The function to wrap.
 * @param options - Optional trace settings.
 * @returns A wrapped function with the same signature.
 *
 * @example
 * ```ts
 * const summarize = traceTask("summarize", async (text: string) => {
 *   return llm.generate(`Summarize: ${text}`);
 * });
 * ```
 */
export function traceTask<TArgs extends unknown[], TReturn>(
  name: string,
  fn: (...args: TArgs) => TReturn,
  options?: TraceOptions,
): (...args: TArgs) => TReturn {
  return makeWrapper(name, fn, SPAN_KIND_TASK, options);
}

/**
 * Trace a function as an agent span.
 *
 * Use for autonomous agent logic that makes decisions and
 * invokes tools.
 *
 * @param name - Span name for the agent.
 * @param fn - The function to wrap.
 * @param options - Optional trace settings.
 * @returns A wrapped function with the same signature.
 *
 * @example
 * ```ts
 * const agent = traceAgent("research_agent", async (query: string) => {
 *   while (!done) {
 *     const action = await decideNextAction(query);
 *     result = await executeAction(action);
 *   }
 *   return result;
 * });
 * ```
 */
export function traceAgent<TArgs extends unknown[], TReturn>(
  name: string,
  fn: (...args: TArgs) => TReturn,
  options?: TraceOptions,
): (...args: TArgs) => TReturn {
  return makeWrapper(name, fn, SPAN_KIND_AGENT, options);
}

/**
 * Trace a function as a tool span.
 *
 * Use for tool/function calls invoked by agents.
 *
 * @param name - Span name for the tool.
 * @param fn - The function to wrap.
 * @param options - Optional trace settings.
 * @returns A wrapped function with the same signature.
 *
 * @example
 * ```ts
 * const search = traceTool("web_search", async (query: string) => {
 *   return searchApi.query(query);
 * });
 * ```
 */
export function traceTool<TArgs extends unknown[], TReturn>(
  name: string,
  fn: (...args: TArgs) => TReturn,
  options?: TraceOptions,
): (...args: TArgs) => TReturn {
  return makeWrapper(name, fn, SPAN_KIND_TOOL, options);
}

/**
 * Create a wrapper function that wraps the original function in an OTEL span.
 *
 * Handles both sync and async functions transparently. When the wrapped
 * function returns a Promise, the span is ended when the Promise settles.
 */
function makeWrapper<TArgs extends unknown[], TReturn>(
  spanName: string,
  fn: (...args: TArgs) => TReturn,
  spanKind: string,
  options?: TraceOptions,
): (...args: TArgs) => TReturn {
  const wrappedFn = (...args: TArgs): TReturn => {
    const tracer = trace.getTracer(TRACER_NAME);

    return tracer.startActiveSpan(spanName, (span: Span) => {
      setSpanAttributes(span, spanKind, options?.version, args);

      try {
        const result = fn(...args);

        // Handle async functions: result is a Promise
        if (result instanceof Promise) {
          return result
            .then((resolved) => {
              setOutput(span, resolved);
              span.end();
              return resolved;
            })
            .catch((err: Error) => {
              span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
              span.recordException(err);
              span.end();
              throw err;
            }) as TReturn;
        }

        // Sync function
        setOutput(span, result);
        span.end();
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        span.recordException(err as Error);
        span.end();
        throw err;
      }
    });
  };

  // Preserve function name for debugging
  Object.defineProperty(wrappedFn, "name", { value: fn.name || spanName });
  return wrappedFn;
}

/**
 * Set standard attributes on a span.
 */
function setSpanAttributes(
  span: Span,
  spanKind: string,
  version: number | undefined,
  args: unknown[],
): void {
  // GenAI semantic convention
  span.setAttribute("gen_ai.operation.name", spanKind);

  if (version !== undefined) {
    span.setAttribute("gen_ai.entity.version", version);
  }

  // Capture input (best-effort, don't fail if serialization fails)
  setInput(span, args);
}

/**
 * Attempt to capture function input as a span attribute.
 */
function setInput(span: Span, args: unknown[]): void {
  try {
    if (args.length === 0) return;

    const value = args.length === 1 ? args[0] : args;
    let serialized = JSON.stringify(value, (_key, val) =>
      typeof val === "bigint" ? val.toString() : val
    );

    if (serialized.length > MAX_ATTRIBUTE_LENGTH) {
      serialized = serialized.slice(0, MAX_ATTRIBUTE_LENGTH) + "...(truncated)";
    }

    span.setAttribute("gen_ai.entity.input", serialized);
  } catch {
    // Silently ignore serialization errors
  }
}

/**
 * Attempt to capture function output as a span attribute.
 */
function setOutput(span: Span, result: unknown): void {
  try {
    if (result === undefined || result === null) return;

    let serialized = JSON.stringify(result, (_key, val) =>
      typeof val === "bigint" ? val.toString() : val
    );

    if (serialized.length > MAX_ATTRIBUTE_LENGTH) {
      serialized = serialized.slice(0, MAX_ATTRIBUTE_LENGTH) + "...(truncated)";
    }

    span.setAttribute("gen_ai.entity.output", serialized);
  } catch {
    // Silently ignore serialization errors
  }
}
