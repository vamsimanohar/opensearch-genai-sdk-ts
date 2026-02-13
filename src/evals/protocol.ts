/**
 * Scorer protocol and Score interface.
 *
 * Defines the interface that any scorer must implement to work with
 * evaluate(). Compatible with autoevals and phoenix-evals scorers
 * via adapters.
 */

/**
 * Result from a scorer evaluation.
 */
export interface Score {
  /** The scorer name (e.g., "Factuality", "Relevance"). */
  name: string;
  /** Numeric score, typically 0.0 to 1.0. */
  value?: number;
  /** Optional categorical label (e.g., "A", "relevant"). */
  label?: string;
  /** Optional explanation from the scorer. */
  rationale?: string;
  /** Optional additional data from the scorer. */
  metadata?: Record<string, unknown>;
}

/**
 * Interface for evaluation scorers.
 *
 * Any object with a `name` property and a callable `score` method
 * that accepts input/output/expected keyword arguments and returns
 * a Score-like result is a valid scorer.
 *
 * Compatible with:
 * - autoevals scorers (Factuality, Levenshtein, etc.)
 * - phoenix-evals evaluators
 * - Custom scorers
 *
 * @example
 * ```ts
 * const myScorer: Scorer = {
 *   name: "my_check",
 *   score({ input, output }) {
 *     const passed = output.toLowerCase().includes("yes");
 *     return { name: "my_check", value: passed ? 1.0 : 0.0 };
 *   },
 * };
 * ```
 */
export interface Scorer {
  /** Name of this scorer. */
  name: string;

  /**
   * Score a single input/output pair.
   *
   * @param args.input - The input that was given to the task.
   * @param args.output - The output from the task.
   * @param args.expected - The expected output (if available).
   * @returns A Score or Score-like result (number, object with score property, etc.)
   */
  score(args: { input: string; output: string; expected?: string }): unknown;
}

/**
 * Convert a scorer result to our Score interface.
 *
 * Handles results from autoevals, phoenix-evals, and raw dicts/floats.
 */
export function adaptScore(scorerName: string, result: unknown): Score {
  // Already a Score
  if (isScore(result)) {
    return result;
  }

  // autoevals returns objects with .score, .metadata, .name attributes
  if (isAutoEvalsResult(result)) {
    return {
      name: scorerName,
      value: result.score,
      label: result.choice ?? result.label,
      rationale: result.rationale,
      metadata: result.metadata ?? {},
    };
  }

  // phoenix-evals returns objects with .label, .score, .explanation
  if (isPhoenixEvalsResult(result)) {
    return {
      name: scorerName,
      value: result.score,
      label: result.label,
      rationale: result.explanation,
    };
  }

  // Plain number
  if (typeof result === "number") {
    return { name: scorerName, value: result };
  }

  // Dict-like object
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    return {
      name: scorerName,
      value: (obj.value as number | undefined) ?? (obj.score as number | undefined),
      label: obj.label as string | undefined,
      rationale: (obj.rationale as string | undefined) ?? (obj.explanation as string | undefined),
      metadata: Object.fromEntries(
        Object.entries(obj).filter(
          ([k]) => !["value", "score", "label", "rationale", "explanation"].includes(k),
        ),
      ),
    };
  }

  // Fallback
  return { name: scorerName, metadata: { raw: String(result) } };
}

// --- Type guards ---

function isScore(value: unknown): value is Score {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.name === "string" && ("value" in obj || "label" in obj);
}

interface AutoEvalsResult {
  score: number;
  choice?: string;
  label?: string;
  rationale?: string;
  metadata?: Record<string, unknown>;
}

function isAutoEvalsResult(value: unknown): value is AutoEvalsResult {
  if (typeof value !== "object" || value === null) return false;
  return "score" in value && typeof (value as Record<string, unknown>).score === "number";
}

interface PhoenixEvalsResult {
  label: string;
  score?: number;
  explanation: string;
}

function isPhoenixEvalsResult(value: unknown): value is PhoenixEvalsResult {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.label === "string" && typeof obj.explanation === "string";
}
