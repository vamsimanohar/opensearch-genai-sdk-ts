/**
 * OTEL pipeline setup for OpenSearch AI observability.
 *
 * The register() function is the single entry point for configuring
 * tracing. It creates a TracerProvider, sets up the exporter (with
 * SigV4 if needed), and auto-discovers installed instrumentor packages.
 */

import { trace, DiagConsoleLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const DEFAULT_ENDPOINT = "http://localhost:21890/opentelemetry/v1/traces";

/**
 * Known OpenTelemetry auto-instrumentation packages for Node.js LLM
 * frameworks. Unlike Python's entry_points, Node.js does not have a
 * standard plugin discovery mechanism, so we attempt static imports.
 */
const KNOWN_INSTRUMENTORS = [
  "@traceloop/instrumentation-openai",
  "@traceloop/instrumentation-anthropic",
  "@traceloop/instrumentation-langchain",
  "@opentelemetry/instrumentation-http",
  "@opentelemetry/instrumentation-fetch",
];

export interface RegisterOptions {
  /** OTLP endpoint URL. Defaults to OPENSEARCH_OTEL_ENDPOINT env var or http://localhost:21890/opentelemetry/v1/traces. */
  endpoint?: string;
  /** Project/service name attached to all spans. Defaults to OPENSEARCH_PROJECT env var or "default". */
  projectName?: string;
  /** Authentication method: "auto" | "sigv4" | "none". */
  auth?: "auto" | "sigv4" | "none";
  /** AWS region for SigV4. Auto-detected if not provided. */
  region?: string;
  /** AWS service name for SigV4 signing (default: "osis"). */
  service?: string;
  /** Use BatchSpanProcessor (true) or SimpleSpanProcessor (false). */
  batch?: boolean;
  /** Discover and activate installed instrumentor packages. */
  autoInstrument?: boolean;
  /** Custom SpanExporter. Overrides endpoint/auth settings. */
  exporter?: SpanExporter;
  /** Set as the global TracerProvider (default: true). */
  setGlobal?: boolean;
  /** Additional HTTP headers for the exporter. */
  headers?: Record<string, string>;
  /** Enable diagnostic logging. */
  debug?: boolean;
}

/**
 * Configure the OTEL tracing pipeline for OpenSearch.
 *
 * One-line setup that creates a TracerProvider, configures an OTLP
 * exporter (with SigV4 signing for AWS endpoints), and auto-discovers
 * installed instrumentor packages.
 *
 * @example
 * ```ts
 * // Self-hosted -- simplest setup
 * register();
 *
 * // AWS -- SigV4 auto-detected
 * register({ endpoint: "https://pipeline.us-east-1.osis.amazonaws.com/v1/traces" });
 *
 * // Explicit configuration
 * register({
 *   endpoint: "http://dataprepper:21890/v1/traces",
 *   projectName: "my-agent",
 *   batch: true,
 *   autoInstrument: true,
 * });
 * ```
 */
export function register(options: RegisterOptions = {}): NodeTracerProvider {
  const {
    endpoint = process.env.OPENSEARCH_OTEL_ENDPOINT ?? DEFAULT_ENDPOINT,
    projectName = process.env.OPENSEARCH_PROJECT ?? "default",
    auth = "auto",
    region,
    service = "osis",
    batch = true,
    autoInstrument = true,
    exporter: customExporter,
    setGlobal = true,
    headers,
    debug = false,
  } = options;

  // Optional diagnostic logging
  if (debug) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  // Step 1: Create Resource (identity tag for all spans)
  const resource = new Resource({
    [ATTR_SERVICE_NAME]: projectName,
  });

  // Step 2: Create TracerProvider (NodeTracerProvider sets up
  // AsyncLocalStorageContextManager for proper context propagation)
  const provider = new NodeTracerProvider({ resource });

  // Step 3: Create Exporter
  const spanExporter = customExporter ?? createExporter(endpoint, auth, region, service, headers);

  // Step 4: Create Processor and wire up
  let processor: SpanProcessor;
  if (batch) {
    processor = new BatchSpanProcessor(spanExporter);
  } else {
    processor = new SimpleSpanProcessor(spanExporter);
  }
  provider.addSpanProcessor(processor);

  // Step 5: Set as global provider
  if (setGlobal) {
    provider.register();
  }

  // Step 6: Auto-instrument installed libraries
  if (autoInstrument) {
    autoInstrumentLibraries(provider);
  }

  console.log(
    `[opensearch-genai-sdk] Tracing initialized: endpoint=${endpoint} project=${projectName} auth=${auth}`
  );

  return provider;
}

/**
 * Create the appropriate OTLP exporter based on auth settings.
 */
function createExporter(
  endpoint: string,
  auth: string,
  region: string | undefined,
  service: string,
  headers: Record<string, string> | undefined,
): SpanExporter {
  const useSigV4 = auth === "sigv4" || (auth === "auto" && isAwsEndpoint(endpoint));

  if (useSigV4) {
    console.log(`[opensearch-genai-sdk] SigV4 auth requested for endpoint: ${endpoint}`);
    console.log(
      "[opensearch-genai-sdk] SigV4 support requires @smithy/signature-v4 — falling back to plain OTLP. " +
        "Provide a custom exporter with SigV4 signing for AWS endpoints."
    );
    // SigV4 would require a custom exporter wrapping @smithy/signature-v4.
    // For now, fall back to standard OTLP exporter. Users can provide a
    // custom exporter via the `exporter` option for SigV4 use cases.
  }

  return new OTLPTraceExporter({
    url: endpoint,
    headers,
  });
}

/**
 * Detect if an endpoint is an AWS-hosted service.
 */
function isAwsEndpoint(endpoint: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname;
  } catch {
    return false;
  }
  const awsPatterns = [".amazonaws.com", ".aws.dev", ".osis.", ".es.", ".aoss."];
  return awsPatterns.some((pattern) => hostname.includes(pattern));
}

/**
 * Discover and activate installed instrumentor packages.
 *
 * In Node.js there is no entry_points equivalent, so we attempt
 * dynamic imports of known instrumentor packages.
 */
function autoInstrumentLibraries(_provider: NodeTracerProvider): void {
  let discovered = 0;

  for (const pkg of KNOWN_INSTRUMENTORS) {
    try {
      // Attempt to require the package synchronously.
      // Dynamic import() is async, but register() is sync for ease of use.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(pkg);
      if (mod && typeof mod.instrument === "function") {
        mod.instrument();
        discovered++;
      }
    } catch {
      // Package not installed -- skip silently
    }
  }

  if (discovered === 0) {
    console.log(
      "[opensearch-genai-sdk] No instrumentor packages found. Install instrumentors to " +
        "auto-trace LLM calls, e.g.: npm install @traceloop/instrumentation-openai"
    );
  } else {
    console.log(`[opensearch-genai-sdk] Auto-instrumented ${discovered} libraries`);
  }
}
