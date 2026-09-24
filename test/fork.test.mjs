// Tests for the fork's additions: file-backed jev_ask, jev_locate, tool
// annotations, the operator switch, the usage ledger, and provider selection.
// Same rig as the rest of the suite: the built server over stdio against the
// local stand-in API, so every assertion is about what actually goes out.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lineWindows, resolveProvider } from "../dist/lib.js";
import { payload, startMock, withClient } from "./helpers.mjs";

const SENTINEL = "SENTINEL_c41f";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "jev-fork-"));
  const root = join(base, "root");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "status.md"), `Next: wire the API client. ${SENTINEL}`);
  writeFileSync(join(root, "adr.md"), "We retry with exponential backoff.");
  writeFileSync(join(root, ".env"), "TOKEN=x");
  writeFileSync(join(root, "app.log"), ["boot ok", "", "listening on 8080", "ERROR upstream timeout"].join("\n"));
  return { base, root };
}

const ASK = [{ id: "next", type: "classify", question: "What comes next per `status.md`?", options: { api: "API work", ui: "UI work" } }];

// ── Pure helpers ────────────────────────────────────────────────────────────

test("an OpenRouter key selects OpenRouter's endpoint and model id", () => {
  assert.deepEqual(resolveProvider("sk-or-v1-abc", {}), {
    name: "openrouter",
    baseURL: "https://openrouter.ai/api",
    model: "~typesafe/jev-latest",
  });
  assert.deepEqual(resolveProvider("ts_live_abc", {}), { name: "typesafe", baseURL: undefined, model: "jev-latest" });
  assert.deepEqual(resolveProvider(undefined, {}), { name: "typesafe", baseURL: undefined, model: "jev-latest" });
});

test("explicit TYPESAFE_BASE_URL and JEV_MODEL win over what the key implies", () => {
  const p = resolveProvider("sk-or-v1-abc", { TYPESAFE_BASE_URL: "http://x", JEV_MODEL: "jev-1.13.0" });
  assert.equal(p.baseURL, "http://x");
  assert.equal(p.model, "jev-1.13.0");
});

test("line windows skip blank lines, keep 1-based numbers, and respect both caps", () => {
  const w = lineWindows("a\n\nb\r\nc", 1000);
  assert.equal(w.length, 1);
  assert.deepEqual(w[0], { first: 1, lines: { L0001: "a", L0003: "b", L0004: "c" } });

  const many = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n");
  const byCount = lineWindows(many, 1_000_000);
  assert.deepEqual(byCount.map((x) => Object.keys(x.lines).length), [254, 254, 92], "a Choice holds 254 lines plus the no-match option");
  assert.equal(byCount[1].first, 255);

  const bySize = lineWindows("aaaa\nbbbb\ncccc", 25);
  assert.equal(bySize.length, 2, "a window closes before its tagged text passes maxChars");
  assert.throws(() => lineWindows("x".repeat(50), 20), /above the 20 limit/);
});

// ── Contract ────────────────────────────────────────────────────────────────

test("every tool is annotated read-only so clients may run them in parallel", async () => {
  await withClient({ withKey: false }, async (client) => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} readOnlyHint`);
      assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} destructiveHint`);
    }
  });
});

// ── jev_ask with paths ──────────────────────────────────────────────────────

test("jev_ask with paths sends the files as one state keyed by path and never returns their content", async () => {
  const { root } = fixture();
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url, env: { JEV_FILE_ROOTS: root } }, async (client) => {
      const result = await client.callTool({ name: "jev_ask", arguments: { paths: ["status.md", "adr.md"], questions: ASK } });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      const sent = mock.only();
      assert.deepEqual(Object.keys(sent.state), ["status.md", "adr.md"]);
      assert.match(sent.state["status.md"], new RegExp(SENTINEL));
      const text = JSON.stringify(result);
      assert.ok(!text.includes(SENTINEL), "file content must never reach the tool result");
      assert.deepEqual(payload(result).files.map((f) => f.path), ["status.md", "adr.md"]);
    });
  } finally {
    await mock.close();
  }
});

test("jev_ask requires exactly one of state or paths", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      for (const args of [{ questions: ASK }, { state: "s", paths: ["a.md"], questions: ASK }]) {
        const result = await client.callTool({ name: "jev_ask", arguments: args });
        assert.equal(result.isError, true);
        assert.match(payload(result).error.message, /exactly one of state or paths/);
      }
      assert.equal(mock.requests.length, 0);
    });
  } finally {
    await mock.close();
  }
});

test("jev_ask refuses a credential file among paths and sends nothing", async () => {
  const { root } = fixture();
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url, env: { JEV_FILE_ROOTS: root } }, async (client) => {
      const result = await client.callTool({ name: "jev_ask", arguments: { paths: ["status.md", ".env"], questions: ASK } });
      assert.equal(result.isError, true);
      assert.equal(payload(result).error.kind, "file_access");
      assert.equal(mock.requests.length, 0, "one bad path fails the call before any request");
    });
  } finally {
    await mock.close();
  }
});

// ── jev_locate ──────────────────────────────────────────────────────────────

test("jev_locate tags each non-empty line, asks where + whether, and returns line numbers only", async () => {
  const { root } = fixture();
  const mock = await startMock();
  try {
    mock.state.noul = 0.9;
    await withClient({ baseUrl: mock.url, env: { JEV_FILE_ROOTS: root } }, async (client) => {
      const result = await client.callTool({
        name: "jev_locate",
        arguments: { path: "app.log", question: "Which line shows the failure?", top: 2 },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      const sent = mock.only();
      assert.equal(sent.state, "L0001| boot ok\nL0003| listening on 8080\nL0004| ERROR upstream timeout");
      assert.deepEqual(Object.keys(sent.questions.where.criteria), ["L0001", "L0003", "L0004", "none"]);
      assert.equal(sent.questions.exists.type, "noul");

      const body = payload(result);
      assert.equal(body.found, "yes");
      assert.equal(body.lines.length, 2);
      assert.equal(body.lines[0].line, 1, "the stand-in favours the first option");
      assert.ok(body.lines.every((l) => l.line !== undefined && !("text" in l)));
      assert.ok(!JSON.stringify(result).includes("ERROR upstream"), "line text never reaches the tool result");
      assert.equal(body.lines_considered, 3);
    });
  } finally {
    await mock.close();
  }
});

test("jev_locate splits long content into windows and ranks across them", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      const text = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
      const body = payload(await client.callTool({ name: "jev_locate", arguments: { text, question: "q" } }));
      assert.equal(mock.requests.length, 2);
      assert.equal(body.windows, 2);
      assert.equal(body.lines_considered, 300);
      assert.deepEqual(body.lines.slice(0, 2).map((l) => l.line).sort((a, b) => a - b), [1, 255], "each window's pick competes");
    });
  } finally {
    await mock.close();
  }
});

test("jev_locate rejects a malformed answer instead of ranking it", async () => {
  const mock = await startMock();
  try {
    mock.state.answers = { where: { type: "choice", choice: "L9999", confidence: 0.9, probabilities: { L9999: 1 } }, exists: { type: "noul", noul: 0.9 } };
    await withClient({ baseUrl: mock.url }, async (client) => {
      const result = await client.callTool({ name: "jev_locate", arguments: { text: "a\nb", question: "q" } });
      assert.equal(result.isError, true);
      assert.equal(payload(result).error.kind, "malformed_response");
    });
  } finally {
    await mock.close();
  }
});

// ── Operator switch and ledger ──────────────────────────────────────────────

test("with JEV_SWITCH_FILE set, the tools refuse unless it says enabled, and nothing is sent", async () => {
  const { base } = fixture();
  const switchFile = join(base, "state.json");
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url, env: { JEV_SWITCH_FILE: switchFile } }, async (client) => {
      const call = () => client.callTool({ name: "jev_check", arguments: { state: "s", question: "q" } });

      let result = await call(); // file missing → off
      assert.equal(result.isError, true);
      assert.equal(payload(result).error.kind, "disabled");

      writeFileSync(switchFile, '{"enabled":false}');
      assert.equal((await call()).isError, true);
      assert.equal(mock.requests.length, 0, "a switched-off server must not call the API");

      writeFileSync(switchFile, '{"enabled":true}');
      result = await call();
      assert.notEqual(result.isError, true);
      assert.equal(mock.requests.length, 1, "the switch is read per call, no restart needed");
    });
  } finally {
    await mock.close();
  }
});

test("JEV_LEDGER gets one line per call with usage and cost, never content", async () => {
  const { base, root } = fixture();
  const ledger = join(base, "ledger", "ledger.jsonl");
  const switchFile = join(base, "state.json");
  writeFileSync(switchFile, '{"enabled":true}');
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url, env: { JEV_FILE_ROOTS: root, JEV_LEDGER: ledger, JEV_SWITCH_FILE: switchFile } }, async (client) => {
      await client.callTool({ name: "jev_ask", arguments: { paths: ["status.md"], questions: ASK } });
      await client.callTool({ name: "jev_triage", arguments: { query: "q", items: [{ id: "a", text: "x" }, { id: "b", text: "y" }] } });
      writeFileSync(switchFile, '{"enabled":false}');
      await client.callTool({ name: "jev_check", arguments: { state: SENTINEL, question: "q" } });
    });
    const raw = readFileSync(ledger, "utf8");
    assert.ok(!raw.includes(SENTINEL), "the ledger must never hold content");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.tool, l.ok, l.questions]), [["jev_ask", true, 1], ["jev_triage", true, 2], ["jev_check", false, 0]]);
    assert.equal(lines[0].input_tokens, 10);
    assert.ok(lines[0].cost > 0, "cost is estimated from list price when the gateway reports none");
    assert.equal(lines[2].reason, "disabled");
    assert.equal(lines[0].client, "jev-mcp-test");
  } finally {
    await mock.close();
  }
});

test("without JEV_SWITCH_FILE or JEV_LEDGER the server behaves as upstream: on, no ledger", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      const result = await client.callTool({ name: "jev_check", arguments: { state: "s", question: "q" } });
      assert.notEqual(result.isError, true);
    });
  } finally {
    await mock.close();
  }
});
