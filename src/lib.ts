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
  choice,
  NotFoundError,
  noul,
  PermissionDeniedError,
  RateLimitError,
  score,
  UnprocessableEntityError,
} from "@typesafe-ai/sdk";
import type { EntryType, Question, ScoreCriteria } from "@typesafe-ai/sdk";

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
/**
 * A tool call that waits on a slow judgment stalls the agent that asked, so the
 * defaults favour failing fast: a short timeout and no SDK retries. Both are
 * configurable for batch work where waiting is fine.
 */
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_RETRIES = 0;

/**
 * Caps for `jev_triage`, which fans one question set out over many items. Each
 * item is its own API request, so items × concurrency is the blast radius of a
 * single call. Both are configurable; concurrency is also hard-capped.
 */
export const DEFAULT_MAX_ITEMS = 50;
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;

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
  | "malformed_response"
  | "file_access"
  | "disabled"
  | "unknown";

export interface DescribedError {
  kind: ErrorKind;
  message: string;
  /** True when the same request may succeed later. */
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

  if (error instanceof DisabledError) {
    return { kind: "disabled", message, retryable: false, hint: "Carry on without Jev. Only the user can switch it on; do not ask them to unless Jev is essential." };
  }

  if (error instanceof MalformedResponseError) {
    return {
      kind: "malformed_response",
      message,
      retryable: true,
      hint: "The API returned an answer that does not match the question sent. Nothing here should be acted on. Retry once; if it persists, report it with the model id.",
    };
  }
  if (error instanceof FileAccessError) {
    return { kind: "file_access", message, retryable: false, hint: error.hint };
  }
  if (error instanceof APIUserAbortError || (error instanceof Error && error.name === "AbortError")) {
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
    return { kind: "connection", message, retryable: true, hint: "Check network access to the API (api.typesafe.ai or openrouter.ai)." };
  }

  if (error instanceof APIError) {
    const base = { message, status: error.status, requestId: error.requestId };
    if (error instanceof AuthenticationError) {
      return { ...base, kind: "authentication", retryable: false, hint: "The API key was rejected. Check TYPESAFE_API_KEY or OPENROUTER_API_KEY in the server's environment, or the key file." };
    }
    if (error instanceof PermissionDeniedError) {
      return { ...base, kind: "permission_denied", retryable: false, hint: "The key is valid but lacks access to this model or account." };
    }
    if (error instanceof RateLimitError) {
      return { ...base, kind: "rate_limit", retryable: true, hint: "Rate limited. Back off before trying again." };
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

// ── Answer validation ───────────────────────────────────────────────────────

/**
 * Thrown when the API returns an answer that does not match the question that
 * was sent. Nothing downstream should act on such an answer.
 */
/** Thrown when the operator switch (JEV_SWITCH_FILE) says off. */
export class DisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisabledError";
  }
}

export class MalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedResponseError";
  }
}

/**
 * Thrown when a `path` item cannot be read: outside the allowed roots, a
 * credential file, a directory, binary, oversized, or missing. Never retryable.
 * The message never includes file contents.
 */
export class FileAccessError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = "FileAccessError";
    this.hint = hint;
  }
}

// ── Question sets ───────────────────────────────────────────────────────────
//
// `jev_ask` and `jev_triage` accept the same list of typed questions. Building
// the SDK questions and checking the answers that come back live here so both
// tools enforce identical rules, and so a triage over fifty items is exactly
// fifty asks.

export interface QuestionSpec {
  id: string;
  type: "classify" | "score" | "check";
  question: EntryType;
  options?: Record<string, EntryType>;
  add_none?: boolean;
  levels?: EntryType[];
  yes_means?: EntryType;
  no_means?: EntryType;
}

/** What each answer must be checked against once it comes back. */
export type ExpectedAnswer = { type: "classify"; keys: string[] } | { type: "score"; levels: number } | { type: "check" };

export interface BuiltQuestionSet {
  built: Record<string, Question>;
  /** For each 'classify' question, the key carrying the no-match meaning, or null. */
  noneOptions: Record<string, string | null>;
  expected: Record<string, ExpectedAnswer>;
}

/**
 * Turn caller question specs into SDK questions.
 *
 * @throws on too many questions, duplicate ids, a classify without options, a
 *         score without levels, or an oversized option or level set.
 */
export function buildQuestionSet(questions: readonly QuestionSpec[], maxQuestions: number): BuiltQuestionSet {
  if (questions.length > maxQuestions) {
    throw new Error(`questions must contain at most ${maxQuestions} entries; received ${questions.length}. Raise JEV_MAX_QUESTIONS if that limit is wrong for your workload.`);
  }
  assertUniqueIds(questions.map((q) => q.id));

  const built: Record<string, Question> = {};
  const noneOptions: Record<string, string | null> = {};
  const expected: Record<string, ExpectedAnswer> = {};

  for (const q of questions) {
    if (q.type === "classify") {
      if (!q.options) throw new Error(`Question '${q.id}' is type 'classify' and needs options.`);
      const { criteria, noneKey } = buildChoiceCriteria(q.options, q.add_none !== false, `options for '${q.id}'`);
      built[q.id] = choice(q.question, criteria);
      noneOptions[q.id] = noneKey;
      expected[q.id] = { type: "classify", keys: Object.keys(criteria) };
    } else if (q.type === "score") {
      if (!q.levels) throw new Error(`Question '${q.id}' is type 'score' and needs levels.`);
      if (q.levels.length < 2) throw new Error(`levels for '${q.id}' must contain at least two entries.`);
      if (q.levels.length > DEFAULT_MAX_SCORE_LEVELS) {
        throw new Error(`levels for '${q.id}' must contain at most ${DEFAULT_MAX_SCORE_LEVELS} entries.`);
      }
      // Length is checked above; the SDK types the rubric as a tuple.
      built[q.id] = score(q.question, q.levels as unknown as ScoreCriteria);
      expected[q.id] = { type: "score", levels: q.levels.length };
    } else {
      const criteria =
        q.yes_means !== undefined || q.no_means !== undefined
          ? { true: q.yes_means ?? null, false: q.no_means ?? null }
          : undefined;
      built[q.id] = criteria ? noul(q.question, criteria) : noul(q.question);
      expected[q.id] = { type: "check" };
    }
  }
  return { built, noneOptions, expected };
}

export interface AnswerGates {
  actAbove: number;
  reviewAbove: number;
  /** When both are set, 'check' answers also carry a verdict. */
  yesAtOrAbove?: number;
  noAtOrBelow?: number;
}

/**
 * Check every answer against the question it was sent for, then attach the
 * confidence gate or verdict.
 *
 * A missing answer is an error, not a silently absent key, so a caller never
 * acts on a partial set.
 *
 * @throws MalformedResponseError on any answer that does not match its question.
 */
export function checkAnswerSet(raw: unknown, expected: Record<string, ExpectedAnswer>, gates: AnswerGates): Record<string, unknown> {
  const answersIn = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, Record<string, unknown> | undefined>;
  const answers: Record<string, unknown> = {};
  for (const [id, want] of Object.entries(expected)) {
    const answer = answersIn[id];
    if (want.type === "classify") validateChoiceAnswer(answer, want.keys, id);
    else if (want.type === "score") validateScoreAnswer(answer, want.levels, id);
    else validateNoulAnswer(answer, id);

    if (want.type === "check" && gates.yesAtOrAbove !== undefined && gates.noAtOrBelow !== undefined) {
      answers[id] = { ...answer, verdict: gateProbability(answer!.noul as number, gates.yesAtOrAbove, gates.noAtOrBelow) };
    } else if (typeof answer?.confidence === "number") {
      answers[id] = { ...answer, action: gateConfidence(answer.confidence, gates.actAbove, gates.reviewAbove) };
    } else {
      answers[id] = answer;
    }
  }
  return answers;
}

/** Probabilities may drift a little in serialization; more than this is a bug. */
export const PROBABILITY_SUM_TOLERANCE = 0.02;

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function sameKeySet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const set = new Set(expected);
  return actual.every((key) => set.has(key));
}

/** A finite distribution over exactly the expected keys that sums to about one. */
function checkDistribution(probabilities: unknown, expectedKeys: readonly string[], label: string): Record<string, number> {
  if (typeof probabilities !== "object" || probabilities === null || Array.isArray(probabilities)) {
    throw new MalformedResponseError(`Answer '${label}' has no probabilities object.`);
  }
  const dist = probabilities as Record<string, unknown>;
  if (!sameKeySet(Object.keys(dist), expectedKeys)) {
    throw new MalformedResponseError(
      `Answer '${label}' has probabilities for ${JSON.stringify(Object.keys(dist))}, but the question offered ${JSON.stringify(expectedKeys)}.`,
    );
  }
  let sum = 0;
  for (const [key, value] of Object.entries(dist)) {
    if (!isUnitInterval(value)) throw new MalformedResponseError(`Answer '${label}' has a probability outside [0, 1] for '${key}'.`);
    sum += value;
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
    throw new MalformedResponseError(`Answer '${label}' has probabilities summing to ${sum.toFixed(3)}, not 1.`);
  }
  return dist as Record<string, number>;
}

function asRecord(answer: unknown, label: string): Record<string, unknown> {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    throw new MalformedResponseError(`No answer came back for '${label}'.`);
  }
  return answer as Record<string, unknown>;
}

/**
 * Check a Choice answer against the options that were sent.
 *
 * The selected option must be one that was offered, the distribution must
 * cover exactly those options, and the selection must carry the highest
 * probability. Any of these failing means the answer cannot be trusted, and a
 * caller acting on `choice` alone would execute something never offered.
 */
export function validateChoiceAnswer(answer: unknown, expectedKeys: readonly string[], label: string): void {
  const a = asRecord(answer, label);
  if (typeof a.choice !== "string" || !expectedKeys.includes(a.choice)) {
    throw new MalformedResponseError(`Answer '${label}' chose ${JSON.stringify(a.choice)}, which was not among the offered options.`);
  }
  if (!isUnitInterval(a.confidence)) throw new MalformedResponseError(`Answer '${label}' has no confidence in [0, 1].`);
  const dist = checkDistribution(a.probabilities, expectedKeys, label);
  const top = Math.max(...Object.values(dist));
  if ((dist[a.choice] ?? -1) < top - 1e-6) {
    throw new MalformedResponseError(`Answer '${label}' chose '${a.choice}' but a different option carries the highest probability.`);
  }
}

/**
 * Check a Score answer against the number of levels that were sent.
 *
 * The legend and the distribution must both describe exactly the levels
 * offered, and the score itself must be a finite number.
 */
export function validateScoreAnswer(answer: unknown, levelCount: number, label: string): void {
  const a = asRecord(answer, label);
  if (typeof a.score !== "number" || !Number.isFinite(a.score)) {
    throw new MalformedResponseError(`Answer '${label}' has no finite score.`);
  }
  if (!isUnitInterval(a.confidence)) throw new MalformedResponseError(`Answer '${label}' has no confidence in [0, 1].`);
  if (typeof a.legend !== "object" || a.legend === null || Array.isArray(a.legend)) {
    throw new MalformedResponseError(`Answer '${label}' has no legend.`);
  }
  const legendKeys = Object.keys(a.legend as Record<string, unknown>);
  if (legendKeys.length !== levelCount) {
    throw new MalformedResponseError(`Answer '${label}' has a legend of ${legendKeys.length} levels; the question sent ${levelCount}.`);
  }
  checkDistribution(a.probabilities, legendKeys, label);
}

/** Check a Noul answer: one finite probability in [0, 1]. */
export function validateNoulAnswer(answer: unknown, label: string): void {
  const a = asRecord(answer, label);
  if (!isUnitInterval(a.noul)) throw new MalformedResponseError(`Answer '${label}' has no probability in [0, 1].`);
}

// ── Provider ────────────────────────────────────────────────────────────────

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";
export const OPENROUTER_MODEL = "~typesafe/jev-latest";

export interface Provider {
  name: "typesafe" | "openrouter";
  /** Undefined leaves the SDK to its own TYPESAFE_BASE_URL / default resolution. */
  baseURL?: string;
  model: string;
}

/**
 * Pick the endpoint from the key itself, so one key file or variable is enough.
 *
 * OpenRouter keys carry an `sk-or-` prefix and OpenRouter serves Jev on the same
 * /v1/systemone shape under its own model id. Explicit TYPESAFE_BASE_URL and
 * JEV_MODEL always win over what the key implies.
 */
export function resolveProvider(key: string | undefined, env: { TYPESAFE_BASE_URL?: string; JEV_MODEL?: string }): Provider {
  const openrouter = key?.startsWith("sk-or-") === true;
  const explicitBase = env.TYPESAFE_BASE_URL?.trim() || undefined;
  return {
    name: openrouter ? "openrouter" : "typesafe",
    baseURL: explicitBase ?? (openrouter ? OPENROUTER_BASE_URL : undefined),
    model: env.JEV_MODEL?.trim() || (openrouter ? OPENROUTER_MODEL : "jev-latest"),
  };
}

// ── Line windows for jev_locate ─────────────────────────────────────────────

export interface LineWindow {
  /** 1-based number of the first line in this window. */
  first: number;
  /** Option key → the line's text, e.g. "L0042" → "…". Empty lines are kept out. */
  lines: Record<string, string>;
}

export function lineId(n: number): string {
  return `L${String(n).padStart(4, "0")}`;
}

/**
 * Split text into windows Jev can answer one Choice over.
 *
 * A Choice takes at most 255 options, so a window holds at most 254 lines (the
 * last option slot is kept for the no-match option). A window also closes before
 * its tagged text would pass `maxChars`. Blank lines are skipped, not options.
 * A single line longer than `maxChars` cannot be judged and is an error.
 */
export function lineWindows(text: string, maxChars: number, maxLines = MAX_CHOICE_OPTIONS - 1): LineWindow[] {
  const windows: LineWindow[] = [];
  let current: LineWindow | undefined;
  let size = 0;
  const all = text.split(/\r?\n/);
  for (let i = 0; i < all.length; i += 1) {
    const line = all[i]!;
    if (line.trim() === "") continue;
    const n = i + 1;
    const cost = line.length + 8;
    if (cost > maxChars) {
      throw new Error(`Line ${n} is ${line.length} characters, above the ${maxChars} limit. Nothing is truncated.`);
    }
    if (!current || Object.keys(current.lines).length >= maxLines || size + cost > maxChars) {
      current = { first: n, lines: {} };
      windows.push(current);
      size = 0;
    }
    current.lines[lineId(n)] = line;
    size += cost;
  }
  return windows;
}

/**
 * Group consecutive block indices into windows under a character budget and an
 * option count, preserving order. A single block over the budget is an error.
 */
export function packBlocks(sizes: readonly number[], maxChars: number, maxPer = MAX_CHOICE_OPTIONS - 1): number[][] {
  const windows: number[][] = [];
  let used = 0;
  sizes.forEach((size, index) => {
    if (size > maxChars) throw new Error(`Block ${index + 1} is ${size} characters, above the ${maxChars} limit.`);
    const current = windows[windows.length - 1];
    if (!current || current.length >= maxPer || used + size > maxChars) {
      windows.push([index]);
      used = size;
    } else {
      current.push(index);
      used += size;
    }
  });
  return windows;
}

/** Split text at line boundaries into chunks of at most `maxChars`. */
export function chunkText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current: string | undefined;
  for (const line of text.split("\n")) {
    if (line.length > maxChars) throw new Error(`A line is ${line.length} characters, above the ${maxChars} limit.`);
    if (current !== undefined && current.length + 1 + line.length <= maxChars) {
      current += `\n${line}`;
    } else {
      if (current !== undefined) chunks.push(current);
      current = line;
    }
  }
  if (current !== undefined) chunks.push(current);
  return chunks;
}

/** Zero-width and bidirectional control characters: invisible to a reader, not to a model. */
const HIDDEN_CHARS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export function countHiddenChars(text: string): number {
  return text.match(HIDDEN_CHARS)?.length ?? 0;
}

// ── Candidate values for jev_extract ────────────────────────────────────────

export const EXTRACT_KINDS = ["number", "version", "url", "email", "date", "quoted", "line"] as const;
export type ExtractKind = (typeof EXTRACT_KINDS)[number];

const CANDIDATE_PATTERNS: Record<Exclude<ExtractKind, "line">, RegExp> = {
  number: /-?\d+(?:[_,]\d{3})*(?:\.\d+)?/g,
  version: /\bv?\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]*[0-9A-Za-z])?(?:\+[0-9A-Za-z.-]+)?/g,
  url: /https?:\/\/[^\s"'<>()]+/g,
  email: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  date: /\b\d{4}-\d{2}-\d{2}\b/g,
  quoted: /"([^"\n]{1,200})"|'([^'\n]{1,200})'|`([^`\n]{1,200})`/g,
};

export interface Candidate {
  value: string;
  /** 1-based line the value appears on. */
  line: number;
}

/**
 * Find every value of a kind, in document order. The model later picks among
 * these, so it can choose the wrong value but never invent one.
 */
export function extractCandidates(text: string, kind: ExtractKind): Candidate[] {
  const out: Candidate[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (kind === "line") {
      if (line.trim() !== "") out.push({ value: line.trim(), line: i + 1 });
      return;
    }
    for (const match of line.matchAll(CANDIDATE_PATTERNS[kind])) {
      let value = match[1] ?? match[2] ?? match[3] ?? match[0];
      if (kind === "url") value = value.replace(/[.,;:!?]+$/, "");
      out.push({ value, line: i + 1 });
    }
  });
  return out;
}
