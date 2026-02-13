/**
 * Score submission for OpenSearch AI observability.
 *
 * Sends evaluation scores and human feedback as OTEL spans through the
 * same exporter pipeline as all other traces. Data Prepper routes these
 * spans to the ai-scores index based on the `opensearch.score` attribute.
 *
 * This keeps everything in OTEL -- no separate OpenSearch client needed
 * for scoring. Same SigV4 auth, same exporter, same pipeline.
 */

import { trace, Span } from "@opentelemetry/api";

const TRACER_NAME = "opensearch-genai-sdk-scores";

export interface ScoreOptions {
  /** Score name (e.g., "relevance", "factuality", "toxicity"). */
  name: string;
  /** Numeric score value (0.0 to 1.0 for NUMERIC). */
  value?: number;
  /** The trace ID being scored. Stored as an attribute (does NOT become the span's own trace ID). */
  traceId?: string;
  /** Optional span ID for span-level scoring. */
  spanId?: string;
  /** Categorical label (for CATEGORICAL scores). */
  label?: string;
  /** Score type -- NUMERIC, CATEGORICAL, or BOOLEAN. */
  dataType?: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  /** Who created the score -- "sdk", "human", "llm-judge", "heuristic". */
  source?: string;
  /** Optional human-readable comment. */
  comment?: string;
  /** Optional explanation from an LLM judge. */
  rationale?: string;
  /** Optional arbitrary metadata. */
  metadata?: Record<string, unknown>;
  /** Project name. Defaults to OPENSEARCH_PROJECT env var. */
  project?: string;
}

/**
 * Submit a score as an OTEL span.
 *
 * Creates a span with score attributes that flows through the same
 * OTLP exporter as all other traces. Data Prepper can route these
 * to a dedicated index based on the `opensearch.score` marker.
 *
 * @example
 * ```ts
 * import { score } from "@opensearch-project/genai-sdk";
 *
 * score({
 *   name: "relevance",
 *   value: 0.95,
 *   traceId: "abc123",
 *   source: "llm-judge",
 *   rationale: "Answer directly addresses the question",
 * });
 * ```
 */
export function score(options: ScoreOptions): void {
  const {
    name,
    value,
    traceId,
    spanId,
    label,
    dataType = "NUMERIC",
    source = "sdk",
    comment,
    rationale,
    metadata,
    project = process.env.OPENSEARCH_PROJECT ?? "default",
  } = options;

  const tracer = trace.getTracer(TRACER_NAME);

  const attrs: Record<string, string | number | boolean> = {
    "opensearch.score": true,
    "score.name": name,
    "score.data_type": dataType,
    "score.source": source,
    "score.project": project,
  };

  if (value !== undefined) {
    attrs["score.value"] = value;
  }
  if (traceId) {
    attrs["score.trace_id"] = traceId;
  }
  if (spanId) {
    attrs["score.span_id"] = spanId;
  }
  if (label) {
    attrs["score.label"] = label;
  }
  if (comment) {
    attrs["score.comment"] = comment;
  }
  if (rationale) {
    attrs["score.rationale"] = rationale.slice(0, 500);
  }
  if (metadata) {
    for (const [k, v] of Object.entries(metadata)) {
      attrs[`score.metadata.${k}`] = String(v);
    }
  }

  tracer.startActiveSpan(`score.${name}`, { attributes: attrs }, (span: Span) => {
    span.end();
  });
}
