/**
 * Scoring with opensearch-genai-sdk.
 *
 * Shows how to submit scores as OTEL spans. Scores flow through the
 * same exporter pipeline as traces -- same SigV4 auth, same Data Prepper
 * endpoint. Data Prepper routes them to the ai-scores index based on
 * the `opensearch.score` attribute.
 *
 * Run with: npx tsx examples/02-scoring.ts
 */

import { register, score } from "../src/index.js";

// --- Setup ---
register({ endpoint: "http://localhost:21890/opentelemetry/v1/traces" });

// --- Numeric score (e.g., from an LLM judge) ---
score({
  name: "relevance",
  value: 0.95,
  traceId: "abc123def456",
  spanId: "789abc",
  source: "llm-judge",
  rationale: "Answer directly addresses the question with correct facts",
});

// --- Categorical score (e.g., human review) ---
score({
  name: "quality",
  label: "good",
  dataType: "CATEGORICAL",
  traceId: "abc123def456",
  source: "human",
  comment: "Reviewed by QA team",
});

// --- Boolean score (e.g., heuristic check) ---
score({
  name: "contains_pii",
  value: 0.0,
  dataType: "BOOLEAN",
  traceId: "abc123def456",
  source: "heuristic",
});

// --- Score with metadata ---
score({
  name: "latency_check",
  value: 1.0,
  traceId: "abc123def456",
  source: "heuristic",
  metadata: { threshold_ms: 500, actual_ms: 120 },
});

// Each score() call creates an OTEL span like:
//
//   Span: score.relevance
//   Attributes:
//     opensearch.score = true        <- Data Prepper routes on this
//     score.name = "relevance"
//     score.value = 0.95
//     score.trace_id = "abc123def456"
//     score.source = "llm-judge"
//     score.rationale = "Answer directly addresses..."

console.log("Scores submitted successfully.");
