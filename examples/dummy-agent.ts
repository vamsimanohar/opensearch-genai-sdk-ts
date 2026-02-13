/**
 * Full agent demo with ConsoleSpanExporter.
 *
 * Mirrors the Python dummy_agent.py -- same agent flow, same span tree.
 * Uses ConsoleSpanExporter so output is visible without any backend.
 *
 * Run with: npx tsx examples/dummy-agent.ts
 *
 * Span tree produced:
 *
 *   qa_pipeline              (workflow)
 *   +-- research_agent       (agent)
 *   |   +-- plan_steps       (task)
 *   |   +-- web_search       (tool)
 *   |   +-- calculator       (tool)
 *   |   +-- summarize        (task)
 *   +-- quality_check        (task)
 */

import { trace } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import {
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import { traceWorkflow, traceTask, traceAgent, traceTool, score } from "../src/index.js";

// --- Setup: ConsoleSpanExporter so we can see spans in stdout ---
const resource = new Resource({ [ATTR_SERVICE_NAME]: "dummy-agent-demo" });
const provider = new NodeTracerProvider({ resource });
provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
provider.register();

// --- Tool: web_search ---
const webSearch = traceTool("web_search", (query: string): Record<string, string>[] => {
  console.log(`  [web_search] Searching for: ${query}`);
  return [
    { title: `OpenSearch overview`, url: "https://opensearch.org/docs" },
    { title: `OpenSearch observability`, url: "https://opensearch.org/observability" },
  ];
});

// --- Tool: calculator ---
const calculator = traceTool("calculator", (expression: string): number => {
  console.log(`  [calculator] Computing: ${expression}`);
  // Simple simulated calculation
  if (expression === "2 + 2") return 4;
  if (expression === "10 * 5") return 50;
  return 42;
});

// --- Task: plan_steps ---
const planSteps = traceTask("plan_steps", (query: string): string[] => {
  console.log(`  [plan_steps] Planning for: ${query}`);
  return ["search the web", "extract key facts", "compute statistics", "summarize findings"];
});

// --- Task: summarize ---
const summarize = traceTask("summarize", (facts: string[]): string => {
  console.log(`  [summarize] Summarizing ${facts.length} facts`);
  return `Based on research: ${facts.join("; ")}. OpenSearch is an open-source search and analytics suite.`;
});

// --- Task: quality_check ---
const qualityCheck = traceTask("quality_check", (answer: string): { passed: boolean; score: number } => {
  console.log(`  [quality_check] Checking quality of answer`);
  const passed = answer.length > 20 && answer.includes("OpenSearch");
  return { passed, score: passed ? 0.95 : 0.3 };
});

// --- Agent: research_agent ---
const researchAgent = traceAgent("research_agent", (query: string): string => {
  console.log(`  [research_agent] Starting research for: ${query}`);

  // Step 1: Plan
  const steps = planSteps(query);
  console.log(`  [research_agent] Plan: ${steps.join(" -> ")}`);

  // Step 2: Search
  const searchResults = webSearch(query);
  const titles = searchResults.map((r) => r.title);

  // Step 3: Calculate something
  const count = calculator("2 + 2");
  console.log(`  [research_agent] Found ${count} key insights`);

  // Step 4: Summarize
  const facts = [...titles, `${count} key insights identified`];
  const summary = summarize(facts);

  return summary;
});

// --- Workflow: qa_pipeline ---
const qaPipeline = traceWorkflow("qa_pipeline", (question: string): string => {
  console.log(`\n=== QA Pipeline: "${question}" ===\n`);

  // Run the research agent
  const answer = researchAgent(question);
  console.log(`\n  [qa_pipeline] Agent answer: ${answer}\n`);

  // Quality check
  const check = qualityCheck(answer);
  console.log(`  [qa_pipeline] Quality: passed=${check.passed}, score=${check.score}\n`);

  // Submit a score for this trace
  score({
    name: "answer_quality",
    value: check.score,
    source: "heuristic",
    rationale: check.passed ? "Answer is comprehensive and relevant" : "Answer needs improvement",
  });

  return answer;
});

// --- Run the pipeline ---
console.log("Starting dummy agent demo...\n");

const result = qaPipeline("What is OpenSearch?");

console.log(`\n=== Final Result ===`);
console.log(result);
console.log(`\n=== Span tree (check ConsoleSpanExporter output above) ===`);
console.log(`
  qa_pipeline              (workflow)
  +-- research_agent       (agent)
  |   +-- plan_steps       (task)
  |   +-- web_search       (tool)
  |   +-- calculator       (tool)
  |   +-- summarize        (task)
  +-- quality_check        (task)
  +-- score.answer_quality (score)
`);

// Force flush to ensure all spans are exported
provider.forceFlush().then(() => {
  provider.shutdown();
});
