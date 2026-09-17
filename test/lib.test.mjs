// Unit tests for the pure helpers. No network, no child process.

import assert from "node:assert/strict";
import test from "node:test";
import { APIError } from "@typesafe-ai/sdk";
import {
  assertStateWithinLimit,
  assertUniqueIds,
  buildChoiceCriteria,
  describeError,
  gateConfidence,
  gateProbability,
  MAX_CHOICE_OPTIONS,
  readPositiveInt,
  resolveNoneKey,
  stateSize,
} from "../dist/lib.js";

test("readPositiveInt falls back loudly instead of yielding NaN", () => {
  assert.deepEqual(readPositiveInt(undefined, 15000, "T"), { value: 15000 });
  assert.deepEqual(readPositiveInt("  ", 15000, "T"), { value: 15000 });
  assert.equal(readPositiveInt("500", 15000, "T").value, 500);
  assert.equal(readPositiveInt("12.7", 15000, "T").value, 12);

  for (const bad of ["abc", "0", "-5", "NaN"]) {
    const parsed = readPositiveInt(bad, 15000, "T");
    assert.equal(parsed.value, 15000, `${bad} should fall back`);
    assert.ok(parsed.warning, `${bad} should warn`);
  }
});

test("resolveNoneKey steps aside when the caller already uses the name", () => {
  assert.equal(resolveNoneKey([]), "none");
  assert.equal(resolveNoneKey(["a", "b"]), "none");
  assert.equal(resolveNoneKey(["none"]), "none_of_these");
  assert.equal(resolveNoneKey(["none", "none_of_these"]), "none_of_these_2");
});

test("buildChoiceCriteria never overwrites a caller's own option", () => {
  const callerMeaning = "The request was already handled; no action needed.";
  const { criteria, noneKey } = buildChoiceCriteria({ none: callerMeaning, escalate: "Send to a human" }, true);

  assert.equal(criteria.none, callerMeaning, "the caller's option must survive verbatim");
  assert.equal(noneKey, "none_of_these");
  assert.equal(criteria.none_of_these, "None of the other options fits.");
});

test("buildChoiceCriteria reports the no-match key it used", () => {
  const { criteria, noneKey } = buildChoiceCriteria({ a: "d", b: "d" }, true);
  assert.equal(noneKey, "none");
  assert.deepEqual(Object.keys(criteria).sort(), ["a", "b", "none"]);

  const off = buildChoiceCriteria({ a: "d", b: "d" }, false);
  assert.equal(off.noneKey, null);
  assert.deepEqual(Object.keys(off.criteria).sort(), ["a", "b"]);
});

test("buildChoiceCriteria rejects empty, single-outcome, and oversized option sets", () => {
  assert.throws(() => buildChoiceCriteria({}, true), /at least one option/);
  assert.throws(() => buildChoiceCriteria({ only: "d" }, false), /at least two outcomes/);

  const tooMany = Object.fromEntries(Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => [`o${i}`, null]));
  assert.throws(() => buildChoiceCriteria(tooMany, false), /at most 255 options/);

  const exactlyAtLimit = Object.fromEntries(Array.from({ length: MAX_CHOICE_OPTIONS }, (_, i) => [`o${i}`, null]));
  assert.doesNotThrow(() => buildChoiceCriteria(exactlyAtLimit, false));
});

test("assertUniqueIds names the duplicates rather than dropping questions", () => {
  assert.doesNotThrow(() => assertUniqueIds(["a", "b", "c"]));
  assert.throws(() => assertUniqueIds(["a", "b", "a"]), /Duplicate question ids: "a"/);
});

test("state size is measured, and oversized state is rejected not truncated", () => {
  assert.equal(stateSize("abcde"), 5);
  assert.equal(stateSize({ a: 1 }), JSON.stringify({ a: 1 }).length);

  assert.doesNotThrow(() => assertStateWithinLimit("abc", 10));
  assert.throws(() => assertStateWithinLimit("a".repeat(20), 10), /above the 10 limit/);
});

test("gateConfidence maps confidence onto an action", () => {
  assert.equal(gateConfidence(0.95, 0.8, 0.5), "act");
  assert.equal(gateConfidence(0.8, 0.8, 0.5), "act");
  assert.equal(gateConfidence(0.6, 0.8, 0.5), "review");
  assert.equal(gateConfidence(0.2, 0.8, 0.5), "abstain");
  assert.equal(gateConfidence(null, 0.8, 0.5), "abstain");
  assert.equal(gateConfidence(undefined, 0.8, 0.5), "abstain");
});

test("gateProbability keeps the middle band uncertain instead of rounding", () => {
  assert.equal(gateProbability(0.9, 0.7, 0.3), "yes");
  assert.equal(gateProbability(0.7, 0.7, 0.3), "yes");
  assert.equal(gateProbability(0.51, 0.7, 0.3), "uncertain", "0.51 is a coin flip, not a yes");
  assert.equal(gateProbability(0.3, 0.7, 0.3), "no");
  assert.equal(gateProbability(0.05, 0.7, 0.3), "no");
});

test("describeError separates failures a caller should treat differently", () => {
  const missing = describeError(new Error("No API key. Set TYPESAFE_API_KEY in the environment."));
  assert.equal(missing.kind, "no_api_key");
  assert.equal(missing.retryable, false);

  const headers = new Headers({ "x-typesafe-request-id": "req_abc" });
  const rateLimited = describeError(APIError.fromResponse(429, {}, headers));
  assert.equal(rateLimited.kind, "rate_limit");
  assert.equal(rateLimited.retryable, true);
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.requestId, "req_abc");

  const unauthorized = describeError(APIError.fromResponse(401, {}, new Headers()));
  assert.equal(unauthorized.kind, "authentication");
  assert.equal(unauthorized.retryable, false, "a bad key never succeeds on retry");

  const malformed = describeError(APIError.fromResponse(422, {}, new Headers()));
  assert.equal(malformed.kind, "invalid_request");
  assert.equal(malformed.retryable, false);

  const overloaded = describeError(APIError.fromResponse(529, {}, new Headers()));
  assert.equal(overloaded.kind, "server_error");
  assert.equal(overloaded.retryable, true);
});
