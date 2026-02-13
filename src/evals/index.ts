/**
 * Evaluation framework for OpenSearch AI observability.
 *
 * Provides the evaluate() orchestrator and Scorer interface for running
 * evaluations on LLM outputs. Compatible with autoevals, phoenix-evals,
 * or any custom scorer that matches the Scorer interface.
 */

export type { Score, Scorer } from "./protocol.js";
export { adaptScore } from "./protocol.js";
export type { EvalResult, EvalSummary, EvalDatum, EvaluateOptions } from "./evaluate.js";
export { evaluate, formatEvalSummary } from "./evaluate.js";
