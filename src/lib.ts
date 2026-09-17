/**
 * Pure helpers for jev-mcp. No network, no process state, no I/O.
 *
 * Everything here is deterministic so the edge cases that matter — a caller
 * whose own option is named "none", duplicate question ids, a malformed
 * timeout — are unit-testable without touching the API.
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@typesafe-ai/sdk";
import type { EntryType } from "@typesafe-ai/sdk";

// ── Limits ──────────────────────────────────────────────────────────────────

/**
 * A Choice question accepts up to 255 options. This is a documented API limit,
 * not a local guess: docs.typesafe.ai/cookbooks/semantic_find.
 */
export const MAX_CHOICE_OPTIONS = 255;

/**
 * Local safety caps, not API limits. They bound cost and latency for a single
 * call so a malformed loop cannot run up a bill. All three are configurable.
 */
export const DEFAULT_MAX_SCORE_LEVELS = 255;
export const DEFAULT_MAX_QUESTIONS = 64;
export const DEFAULT_MAX_STATE_CHARS = 200_000;
export const DEFAULT_TIMEOUT_MS = 15_000;

// ── Environment parsing ─────────────────────────────────────────────────────

export interface ParsedNumber {
  value: number;
  /** Set when the raw value was present but unusable, so the caller can warn. */
  warning?: string;
}

/**
 * Read a positive integer from an environment value.
 *
 * `Number("abc")` is `NaN`, and passing `NaN` as a timeout silently disables
 * it. Anything not a finite positive number falls back and reports why.
 */
export function readPositiveInt(raw: string | undefined, fallback: number, label: string): ParsedNumber {
  if (raw === undefined || raw.trim() === "") return { value: fallback };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { value: fallback, warning: `${label} must be a positive number; got ${JSON.stringify(raw)}. Using ${fallback}.` };
  }
  return { value: Math.floor(parsed) };
}

// ── Choice option handling ──────────────────────────────────────────────────

/**
 * Pick a key for the "none of these" escape hatch that does not collide with a
 * caller's own option.
 *
 * Blindly writing `criteria.none` overwrites an option the caller named "none",
 * destroying its meaning and its probability. That is silent and unrecoverable,
 * so we step aside instead.
 */
export function resolveNoneKey(existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has("none")) return "none";
  if (!taken.has("none_of_these")) return "none_of_these";
  let n = 2;
  while (taken.has(`none_of_these_${n}`)) n += 1;
  return `none_of_these_${n}`;
}

export interface BuiltCriteria {
  criteria: Record<string, EntryType>;
  /** The key that carries the "nothing fits" meaning, or null when not added. */
  noneKey: string | null;
}

/**
 * Build Choice criteria from caller options, optionally adding a no-match
 * outcome under a key guaranteed not to clash.
 *
 * @throws when the option set is empty or exceeds the API's 255-option limit.
 */
export function buildChoiceCriteria(
  options: Record<string, EntryType>,
  addNone: boolean,
  label = "options",
): BuiltCriteria {
  const keys = Object.keys(options);
  if (keys.length === 0) {
    throw new Error(`${label} must contain at least one option. Jev selects among options you supply; it cannot invent one.`);
  }

  const criteria: Record<string, EntryType> = { ...options };
  let noneKey: string | null = null;
  if (addNone) {
    noneKey = resolveNoneKey(keys);
    criteria[noneKey] = "None of the other options fits.";
  }

  const total = Object.keys(criteria).length;
  if (total > MAX_CHOICE_OPTIONS) {
    throw new Error(
      `A Choice question accepts at most ${MAX_CHOICE_OPTIONS} options; received ${total}. ` +
        "For a larger set, search in two passes: one question picks a window, a second ranks within it.",
    );
  }
  if (total < 2) {
    throw new Error(`${label} must leave at least two outcomes. Supply another option, or leave the no-match outcome enabled.`);
  }
  return { criteria, noneKey };
}

/** Reject duplicate question ids rather than letting a later one shadow an earlier one. */
export function assertUniqueIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Duplicate question ids: ${[...duplicates].map((d) => JSON.stringify(d)).join(", ")}. ` +
        "Answers are keyed by id, so a repeat would silently drop every earlier question sharing it.",
    );
  }
}

// ── Size guards ─────────────────────────────────────────────────────────────

/** Serialized size of the state, used to bound cost before a request goes out. */
export function stateSize(state: unknown): number {
  return typeof state === "string" ? state.length : JSON.stringify(state ?? null).length;
}

/**
 * Reject oversized state instead of truncating it.
 *
 * Truncation silently changes the material the judgment rests on, which turns a
 * size problem into a wrong answer. Failing loudly keeps the caller in control.
 */
export function assertStateWithinLimit(state: unknown, maxChars: number): void {
  const size = stateSize(state);
  if (size > maxChars) {
    throw new Error(
      `State is ${size} characters, above the ${maxChars} limit. ` +
        "Shorten it or select the relevant part first; raise JEV_MAX_STATE_CHARS if the limit is wrong for your workload.",
    );
  }
}

// ── Confidence gating ───────────────────────────────────────────────────────

export type Gate = "act" | "review" | "abstain";

/**
 * Turn a Choice/Score confidence into a recommended action.
 *
 * Thresholds are starting points to calibrate on your own data, never universal
 * rules. Confidence describes how concentrated the distribution is; it is not a
 * statement that the answer is correct or that acting is safe.
 */
export function gateConfidence(confidence: number | null | undefined, actAbove: number, reviewAbove: number): Gate {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) return "abstain";
  if (confidence >= actAbove) return "act";
  if (confidence >= reviewAbove) return "review";
  return "abstain";
}

export type Verdict = "yes" | "no" | "uncertain";

/**
 * Turn a Noul probability into a verdict.
 *
 * A Noul has no confidence value. A probability near 0.5 means yes and no are
 * close to equally likely, not that the answer is "medium", so the middle band
 * is reported as uncertain rather than rounded to the nearer side.
 */
export function gateProbability(probability: number, yesAtOrAbove: number, noAtOrBelow: number): Verdict {
  if (probability >= yesAtOrAbove) return "yes";
  if (probability <= noAtOrBelow) return "no";
  return "uncertain";
}

// ── Error reporting ─────────────────────────────────────────────────────────

export type ErrorKind =
  | "no_api_key"
  | "authentication"
  | "permission_denied"
  | "invalid_request"
  | "not_found"
  | "rate_limit"
  | "server_error"
  | "timeout"
  | "connection"
  | "cancelled"
  | "invalid_arguments"
  | "unknown";

export interface DescribedError {
  kind: ErrorKind;
  message: string;
  /** True when the same request may succeed later. The SDK already retried. */
  retryable: boolean;
  status?: number;
  /** TypeSafe request id, the thing support needs to trace a failure. */
  requestId?: string;
  /** What the caller should actually do next. */
  hint?: string;
}

/**
 * Classify a failure so a caller can branch on it.
 *
 * Flattening every failure to a string makes a missing key, a malformed
 * question, and a rate limit indistinguishable, so callers retry things that
 * will never succeed and give up on things that would.
 */
export function describeError(error: unknown): DescribedError {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof APIUserAbortError) {
    return { kind: "cancelled", message, retryable: false, hint: "The client cancelled the request." };
  }
  if (error instanceof APITimeoutError) {
    return {
      kind: "timeout",
      message,
      retryable: true,
      hint: "Shorten the state or raise JEV_TIMEOUT_MS.",
    };
  }
  if (error instanceof APIConnectionError) {
    return { kind: "connection", message, retryable: true, hint: "Check network access to api.typesafe.ai." };
  }

  if (error instanceof APIError) {
    const base = { message, status: error.status, requestId: error.requestId };
    if (error instanceof AuthenticationError) {
      return { ...base, kind: "authentication", retryable: false, hint: "The API key was rejected. Check TYPESAFE_API_KEY in the server's environment." };
    }
    if (error instanceof PermissionDeniedError) {
      return { ...base, kind: "permission_denied", retryable: false, hint: "The key is valid but lacks access to this model or account." };
    }
    if (error instanceof RateLimitError) {
      return { ...base, kind: "rate_limit", retryable: true, hint: "Rate limited after the SDK's own retries. Back off before trying again." };
    }
    if (error instanceof UnprocessableEntityError || error instanceof BadRequestError) {
      return { ...base, kind: "invalid_request", retryable: false, hint: "The request failed validation. The message names the offending field." };
    }
    if (error instanceof NotFoundError) {
      return { ...base, kind: "not_found", retryable: false, hint: "Check the model id in JEV_MODEL." };
    }
    return { ...base, kind: "server_error", retryable: error.status >= 500, hint: "TypeSafe returned an error. Retry if it persists." };
  }

  if (/^No API key/i.test(message)) {
    return {
      kind: "no_api_key",
      message,
      retryable: false,
      hint: "Set TYPESAFE_API_KEY in the environment of the MCP client, not as a tool argument. Many clients filter the environment, so pass it explicitly when registering the server.",
    };
  }

  return { kind: "invalid_arguments", message, retryable: false };
}
