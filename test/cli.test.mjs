// dist/cli.js: the plugin's /jev command and its two hooks. Hooks must stay
// silent while switched off and never block a tool call.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

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

test("the tool hook nudges greps and big whole-file reads, and never blocks", () => {
  const h = home();
  const big = join(h, "big.log");
  writeFileSync(big, "x\n".repeat(20_000));
  const small = join(h, "small.md");
  writeFileSync(small, "tiny");

  const grep = { tool_name: "Grep", tool_input: { pattern: "retry" } };
  const bashRg = { tool_name: "Bash", tool_input: { command: "cd src && rg -n retry" } };
  const bigRead = { tool_name: "Read", tool_input: { file_path: big } };
  assert.equal(hook(h, "tool-hook", grep), undefined, "silent while off");

  run(h, ["on"]);
  for (const event of [grep, bashRg]) {
    const out = hook(h, "tool-hook", event);
    assert.equal(out.hookEventName, "PreToolUse");
    assert.match(out.additionalContext, /jev_search/);
    assert.equal(out.permissionDecision, undefined, "a nudge, never a decision");
  }
  assert.match(hook(h, "tool-hook", bigRead).additionalContext, /jev_locate/);

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
});
