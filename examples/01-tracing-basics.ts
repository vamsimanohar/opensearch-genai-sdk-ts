/**
 * Basic tracing with opensearch-genai-sdk.
 *
 * Shows how to register the SDK and trace custom functions
 * with traceWorkflow, traceTask, traceAgent, and traceTool wrappers.
 *
 * Run with: npx tsx examples/01-tracing-basics.ts
 */

import { register, traceWorkflow, traceTask, traceAgent, traceTool } from "../src/index.js";

// --- Setup ---
// Local Data Prepper
register({ endpoint: "http://localhost:21890/opentelemetry/v1/traces" });

// AWS-hosted (SigV4 is auto-detected from the hostname)
// register({ endpoint: "https://my-pipeline.us-east-1.osis.amazonaws.com/v1/traces" });

// --- Traced functions ---
const search = traceTool("web_search", (query: string): Record<string, string>[] => {
  /** Simulated web search tool. */
  return [{ title: `Result for: ${query}`, url: "https://example.com" }];
});

const summarize = traceTask("summarize", (text: string): string => {
  /** Simulated LLM summarization. */
  return `Summary of: ${text.slice(0, 100)}`;
});

const research = traceAgent("research_agent", (query: string): string => {
  /** Agent that searches, then summarizes. */
  const results = search(query);
  const titles = results.map((r) => r.title).join(", ");
  return summarize(titles);
});

const runPipeline = traceWorkflow("qa_pipeline", (question: string): string => {
  /** Top-level workflow that orchestrates the agent. */
  const answer = research(question);
  return answer;
});

// --- Run ---
const result = runPipeline("What is OpenSearch?");
console.log(result);

// Produces this span tree:
//
//   qa_pipeline          (workflow)
//   +-- research_agent   (agent)
//       +-- web_search   (tool)
//       +-- summarize    (task)
