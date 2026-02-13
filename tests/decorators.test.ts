/**
 * Basic tests for the opensearch-genai-sdk tracing wrappers.
 *
 * Uses the built-in Node.js test runner and InMemorySpanExporter
 * to capture and verify spans without any external backend.
 *
 * Run with: node --import tsx --test tests/decorators.test.ts
 */

import { describe, it, before, afterEach, after } from "node:test";
import assert from "node:assert/strict";

import { trace } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import {
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import { traceWorkflow, traceTask, traceAgent, traceTool, score } from "../src/index.js";

// Set up a single provider/exporter for the entire test suite.
// The global tracer provider can only be registered once per process,
// so we share it across all tests and reset the exporter between tests.
const exporter = new InMemorySpanExporter();
const resource = new Resource({ [ATTR_SERVICE_NAME]: "test" });
const provider = new NodeTracerProvider({ resource });
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();

// Reset the exporter between tests
afterEach(() => {
  exporter.reset();
});

// Shutdown after all tests
after(async () => {
  await provider.shutdown();
});

describe("traceWorkflow", () => {
  it("creates a span with workflow span kind", () => {
    const fn = traceWorkflow("my_workflow", (x: number) => x * 2);
    const result = fn(21);

    assert.equal(result, 42);

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, "my_workflow");
    assert.equal(spans[0].attributes["traceloop.span.kind"], "workflow");
    assert.equal(spans[0].attributes["gen_ai.operation.name"], "workflow");
  });

  it("captures input and output as span attributes", () => {
    const fn = traceWorkflow("io_test", (msg: string) => `Hello, ${msg}!`);
    const result = fn("world");

    assert.equal(result, "Hello, world!");

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].attributes["traceloop.entity.input"], '"world"');
    assert.equal(spans[0].attributes["traceloop.entity.output"], '"Hello, world!"');
  });
});

describe("traceTask", () => {
  it("creates a span with task span kind", () => {
    const fn = traceTask("my_task", () => "done");
    fn();

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, "my_task");
    assert.equal(spans[0].attributes["traceloop.span.kind"], "task");
  });
});

describe("traceAgent", () => {
  it("creates a span with agent span kind", () => {
    const fn = traceAgent("my_agent", (q: string) => `Answer: ${q}`);
    const result = fn("test");

    assert.equal(result, "Answer: test");

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, "my_agent");
    assert.equal(spans[0].attributes["traceloop.span.kind"], "agent");
  });
});

describe("traceTool", () => {
  it("creates a span with tool span kind", () => {
    const fn = traceTool("my_tool", (x: number, y: number) => x + y);
    const result = fn(3, 4);

    assert.equal(result, 7);

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, "my_tool");
    assert.equal(spans[0].attributes["traceloop.span.kind"], "tool");
  });

  it("captures multiple arguments as JSON array", () => {
    const fn = traceTool("multi_arg", (a: string, b: number) => `${a}-${b}`);
    fn("hello", 42);

    const spans = exporter.getFinishedSpans();
    const input = spans[0].attributes["traceloop.entity.input"];
    assert.equal(input, '["hello",42]');
  });
});

describe("async tracing", () => {
  it("handles async functions correctly", async () => {
    const fn = traceWorkflow("async_workflow", async (x: number) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return x * 3;
    });

    const result = await fn(10);
    assert.equal(result, 30);

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, "async_workflow");
    assert.equal(spans[0].attributes["traceloop.span.kind"], "workflow");
    assert.equal(spans[0].attributes["traceloop.entity.output"], "30");
  });

  it("records errors from async functions", async () => {
    const fn = traceTool("failing_tool", async () => {
      throw new Error("async boom");
    });

    await assert.rejects(() => fn(), { message: "async boom" });

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].status.code, 2); // SpanStatusCode.ERROR
  });
});

describe("error handling", () => {
  it("records exceptions and re-throws errors from sync functions", () => {
    const fn = traceTask("failing_task", () => {
      throw new Error("sync boom");
    });

    assert.throws(() => fn(), { message: "sync boom" });

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].status.code, 2); // SpanStatusCode.ERROR
    assert.ok(spans[0].events.length > 0); // exception event recorded
  });
});

describe("nested spans", () => {
  it("creates parent-child relationships between nested traced functions", () => {
    const innerTool = traceTool("inner_tool", (x: number) => x + 1);
    const outerWorkflow = traceWorkflow("outer_workflow", (x: number) => innerTool(x));

    const result = outerWorkflow(5);
    assert.equal(result, 6);

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);

    // Spans are finished inner-first
    const inner = spans.find((s) => s.name === "inner_tool")!;
    const outer = spans.find((s) => s.name === "outer_workflow")!;

    assert.ok(inner);
    assert.ok(outer);

    // Both should share the same trace ID
    assert.equal(
      inner.spanContext().traceId,
      outer.spanContext().traceId,
    );

    // Inner span's parent should be the outer span
    assert.equal(inner.parentSpanId, outer.spanContext().spanId);
  });
});

describe("version attribute", () => {
  it("sets version attribute when provided", () => {
    const fn = traceWorkflow("versioned", () => "ok", { version: 3 });
    fn();

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].attributes["traceloop.entity.version"], 3);
  });
});

describe("score function", () => {
  it("creates a span with score attributes", () => {
    score({
      name: "relevance",
      value: 0.95,
      traceId: "abc123",
      source: "llm-judge",
      rationale: "Good answer",
    });

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, "score.relevance");
    assert.equal(spans[0].attributes["opensearch.score"], true);
    assert.equal(spans[0].attributes["score.name"], "relevance");
    assert.equal(spans[0].attributes["score.value"], 0.95);
    assert.equal(spans[0].attributes["score.trace_id"], "abc123");
    assert.equal(spans[0].attributes["score.source"], "llm-judge");
    assert.equal(spans[0].attributes["score.rationale"], "Good answer");
  });
});
