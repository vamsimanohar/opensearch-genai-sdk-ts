/**
 * OpenSearch AI Observability SDK for TypeScript.
 *
 * OTEL-native tracing, scoring, and evaluation for LLM applications.
 *
 * @packageDocumentation
 */

// Setup
export { register } from "./register.js";
export type { RegisterOptions } from "./register.js";

// Trace wrappers (TypeScript equivalent of Python decorators)
export { traceWorkflow, traceTask, traceAgent, traceTool } from "./decorators.js";
export type { TraceOptions } from "./decorators.js";

// Scoring
export { score } from "./score.js";
export type { ScoreOptions } from "./score.js";

// Evals
export { evaluate, formatEvalSummary } from "./evals/index.js";
export type { Score, Scorer } from "./evals/index.js";
export type { EvalResult, EvalSummary, EvalDatum, EvaluateOptions } from "./evals/index.js";
export { adaptScore } from "./evals/index.js";
