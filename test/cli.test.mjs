// bundle/cli.js: the plugin's /jev command and its two hooks. Hooks must stay
// silent while switched off and never block a tool call.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bundle/cli.js", import.meta.url));

function home() {
  return mkdtempSync(join(tmpdir(), "jev-home-"));
}

function run(jevHome, args, stdin = "") {
  return execFileSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, JEV_HOME: jevHome }, input: stdin, encoding: "utf8" });
}

const hook = (jevHome, kind, event) => {
  const out = run(jevHome, [kind], JSON.stringify(event)).trim();
  return out === "" ? undefined : JSON.parse(out).hookSpecificOutput;
};

test("the switch is off by default, and on/off write the file the server reads", () => {
  const h = home();
  assert.match(run(h, ["status"]), /jev: off/);
  const on = run(h, ["on"]);
  assert.match(on, /OpenRouter|TypeSafe/, "switching on warns where content goes");
  assert.deepEqual(JSON.parse(readFileSync(join(h, "state.json"), "utf8")), { enabled: true });
  run(h, ["off"]);
  assert.deepEqual(JSON.parse(readFileSync(join(h, "state.json"), "utf8")), { enabled: false });
});

test("status totals the ledger by tool, including calls refused while off", () => {
  const h = home();
  writeFileSync(
    join(h, "ledger.jsonl"),
    [
      { tool: "jev_search", ok: true, questions: 4, input_tokens: 1000, cost: 0.0001, ms: 400 },
      { tool: "jev_search", ok: true, questions: 2, input_tokens: 500, cost: 0.00005, ms: 600 },
      { tool: "jev_ask", ok: false, questions: 0, input_tokens: 0, cost: 0, ms: 10, reason: "timeout" },
      { tool: "jev_check", ok: false, questions: 0, input_tokens: 0, cost: 0, ms: 0, reason: "disabled" },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  const out = run(h, ["status"]);
  assert.match(out, /calls: 2 ok, 1 failed, 1 refused while off/);
  assert.match(out, /tokens: 1500/);
  assert.match(out, /cost: \$0\.000150/);
  assert.match(out, /avg latency: 500 ms/);
  assert.match(out, /jev_search 2/);
});

test("an unknown command exits non-zero with usage", () => {
  assert.throws(() => run(home(), ["nope"]), /usage/);
});

test("the prompt hook is silent while off and names the tools while on", () => {
  const h = home();
  assert.equal(hook(h, "prompt-hook", { prompt: "hi" }), undefined);
  run(h, ["on"]);
  const out = hook(h, "prompt-hook", { prompt: "hi" });
  assert.equal(out.hookEventName, "UserPromptSubmit");
  for (const tool of ["jev_search", "jev_locate", "jev_ask", "jev_extract", "jev_screen"]) assert.match(out.additionalContext, new RegExp(tool));
});

test("the first search after a prompt is refused toward jev_search, the next one runs", () => {
  const h = home();
  const session = "3f2a-session";
  const grep = { session_id: session, tool_name: "Grep", tool_input: { pattern: "retry" } };
  const bashRg = { session_id: session, tool_name: "Bash", tool_input: { command: "cd src && rg -n retry | head" } };

  hook(h, "prompt-hook", { session_id: session });
  assert.equal(hook(h, "tool-hook", grep), undefined, "silent while off");

  run(h, ["on"]);
  for (const first of [grep, bashRg]) {
    hook(h, "prompt-hook", { session_id: session });
    const filter = { session_id: session, tool_name: "Bash", tool_input: { command: "npm test 2>&1 | rg fail" } };
    assert.equal(hook(h, "tool-hook", filter), undefined, "filtering a command's output is not a code search");
    const out = hook(h, "tool-hook", first);
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /jev_search/);
    assert.equal(hook(h, "tool-hook", first), undefined, "a second search in the same turn runs untouched");
  }
});

test("a jev call before searching lifts the refusal, and a session id never leaves JEV_HOME", () => {
  const h = home();
  run(h, ["on"]);
  const session = "abc";
  hook(h, "prompt-hook", { session_id: session });
  hook(h, "tool-hook", { session_id: session, tool_name: "mcp__plugin_jev_jev__jev_search", tool_input: {} });
  assert.equal(hook(h, "tool-hook", { session_id: session, tool_name: "Grep", tool_input: {} }), undefined);

  for (const bad of [undefined, "../../escape"]) {
    hook(h, "prompt-hook", { session_id: bad });
    assert.equal(hook(h, "tool-hook", { session_id: bad, tool_name: "Grep", tool_input: {} }), undefined, String(bad));
  }
  assert.ok(!existsSync(join(h, "..", "..", "escape")));
});

test("after a web search, the first WebFetch is refused toward jev_rank_pages", () => {
  const h = home();
  run(h, ["on"]);
  const session = "web-1";
  const search = { session_id: session, tool_name: "WebSearch", tool_input: { query: "jev batching" } };
  const fetch = { session_id: session, tool_name: "WebFetch", tool_input: { url: "https://example.com", prompt: "p" } };

  hook(h, "prompt-hook", { session_id: session });
  assert.equal(hook(h, "tool-hook", fetch), undefined, "a URL the user gave is fetched without a detour");

  assert.equal(hook(h, "tool-hook", search), undefined, "the search itself runs");
  const out = hook(h, "tool-hook", fetch);
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /jev_rank_pages/);
  assert.equal(hook(h, "tool-hook", fetch), undefined, "the retry runs");

  hook(h, "tool-hook", search);
  hook(h, "tool-hook", { session_id: session, tool_name: "mcp__plugin_jev_jev__jev_rank_pages", tool_input: {} });
  assert.equal(hook(h, "tool-hook", fetch), undefined, "ranking first lifts the refusal");

  hook(h, "tool-hook", search);
  hook(h, "prompt-hook", { session_id: session });
  assert.equal(hook(h, "tool-hook", fetch), undefined, "a search from an earlier turn does not carry over");
});

test("the tool hook nudges big whole-file reads and leaves other tools alone", () => {
  const h = home();
  const big = join(h, "big.log");
  writeFileSync(big, "x\n".repeat(20_000));
  const small = join(h, "small.md");
  writeFileSync(small, "tiny");
  const bigRead = { tool_name: "Read", tool_input: { file_path: big } };
  assert.equal(hook(h, "tool-hook", bigRead), undefined, "silent while off");

  run(h, ["on"]);
  const out = hook(h, "tool-hook", bigRead);
  assert.match(out.additionalContext, /jev_locate/);
  assert.equal(out.permissionDecision, undefined, "a read is nudged, never refused");

  for (const quiet of [
    { tool_name: "Read", tool_input: { file_path: small } },
    { tool_name: "Read", tool_input: { file_path: big, offset: 10, limit: 20 } },
    { tool_name: "Read", tool_input: { file_path: join(h, "missing") } },
    { tool_name: "Bash", tool_input: { command: "npm test" } },
    { tool_name: "Edit", tool_input: {} },
  ]) {
    assert.equal(hook(h, "tool-hook", quiet), undefined, JSON.stringify(quiet));
  }
});

test("hooks survive garbage input silently", () => {
  const h = home();
  run(h, ["on"]);
  assert.equal(run(h, ["tool-hook"], "not json").trim(), "");
  assert.equal(run(h, ["prompt-hook"], "").trim().length > 0, true, "the prompt hook does not need its input");
  assert.equal(run(h, ["prompt-hook"], "not json").trim().length > 0, true);
});
