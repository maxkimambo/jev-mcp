// bundle/pi.js: the pi extension. pi has no MCP client, so the extension starts
// the jev server and registers its tools as native pi tools. Driven here with a
// stand-in for pi's ExtensionAPI and the stand-in Jev API.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../bundle/pi.js";
import { startMock } from "./helpers.mjs";

const KEY_VAR = ["TYPESAFE", "API", "KEY"].join("_");

function fakePi() {
  const handlers = {};
  const tools = new Map();
  const commands = {};
  const notes = [];
  const pi = {
    on: (event, handler) => (handlers[event] = handler),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, options) => (commands[name] = options),
    // pi.exec as pi implements it: run a command, collect its output.
    exec: async (command, args) => {
      const { execFile } = await import("node:child_process");
      return new Promise((resolve) => execFile(command, args, (error, stdout, stderr) => resolve({ stdout, stderr, code: error?.code ?? 0 })));
    },
  };
  const ctx = { ui: { notify: (message) => notes.push(message) } };
  return { pi, handlers, tools, commands, notes, ctx };
}

test("the pi extension registers the jev tools natively, honours the switch, and adds /jev", async () => {
  const mock = await startMock();
  const saved = { ...process.env };
  Object.assign(process.env, {
    JEV_HOME: mkdtempSync(join(tmpdir(), "jev-pi-")),
    TYPESAFE_BASE_URL: mock.url,
    [KEY_VAR]: "value-for-the-local-stand-in",
    JEV_KEY_FILE: "/nonexistent/jev-mcp-test/key",
    XDG_CONFIG_HOME: "/nonexistent/jev-mcp-test/config",
  });
  const { pi, handlers, tools, commands, notes, ctx } = fakePi();
  try {
    await extension(pi);
    assert.ok(commands.jev, "/jev is registered at load");
    assert.equal(tools.size, 0, "no server is started until a session starts");

    await handlers.session_start({}, ctx);
    assert.equal(tools.size, 11);
    const check = tools.get("jev_check");
    assert.equal(check.parameters.type, "object", "the server's JSON Schema is passed through");
    assert.ok(check.description.length > 20);

    await assert.rejects(check.execute("t1", { state: "s", question: "q?" }, AbortSignal.timeout(10_000)), /off/, "off by default, as an error pi reports");
    assert.equal(mock.requests.length, 0);

    await commands.jev.handler("on", ctx);
    assert.match(notes.at(-1), /on/);
    const result = await check.execute("t2", { state: "s", question: "q?" }, AbortSignal.timeout(10_000));
    assert.equal(result.details.verdict !== undefined || result.details.noul !== undefined, true, JSON.stringify(result.details));
    assert.match(result.content[0].text, /"model":"mock-jev"/);

    await commands.jev.handler("status", ctx);
    assert.match(notes.at(-1), /jev_check/);
  } finally {
    await handlers.session_shutdown?.({}, ctx);
    process.env = saved;
    await mock.close();
  }
});
