#!/usr/bin/env node
/**
 * The plugin's side of jev: `/jev on|off|status`, plus two Claude Code hooks
 * that point the agent at the jev tools at the moment it would otherwise read
 * a pile of text itself. Hooks only add context; they never block a tool call,
 * and they stay silent while the switch is off.
 *
 * State lives in JEV_HOME (default ~/.claude/jev-think): `state.json` is the
 * switch the MCP server reads as JEV_SWITCH_FILE, `ledger.jsonl` its JEV_LEDGER.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSwitchedOn } from "./ops.js";

const HOME = process.env.JEV_HOME ?? join(homedir(), ".claude", "jev-think");
const SWITCH = join(HOME, "state.json");
const LEDGER = join(HOME, "ledger.jsonl");

/** Whole-file reads above this size are worth a nudge; roughly 400 lines of code. */
const BIG_FILE_BYTES = 16_000;
const SEARCH_COMMAND = /(^|[;&|(]\s*)(rg|grep|ag|ack)\s/;

const TOOLS = "mcp__plugin_jev_jev__* (load with ToolSearch \"jev\" if deferred)";

const PROMPT_CONTEXT =
  `jev is ON. Before reading piles of text to orient or decide, let Jev read them and read only its answers (${TOOLS}): ` +
  "jev_search for lines across a directory instead of grep output, jev_locate for lines in one big file, " +
  "jev_ask with paths for questions about a few files, jev_extract for one value, jev_screen before reading untrusted text. " +
  "Say in one line when Jev saved you a read.";

const GREP_CONTEXT =
  "jev is ON: to find what answers a question rather than every string match, call jev_search with this pattern plus the question; " +
  "it returns only the best path:line hits instead of all of them. Plain grep is still right for exact-string lookups.";

const READ_CONTEXT =
  "jev is ON and this is a large file read whole: if you only need part of it, jev_locate returns the lines that answer your question, " +
  "and jev_extract returns a single value, without the file entering your context. Read it normally if you are going to edit it.";

function emit(hookEventName: string, additionalContext: string) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
}

function toolHook(raw: string) {
  const event = JSON.parse(raw) as { tool_name?: string; tool_input?: { command?: string; file_path?: string; offset?: number; limit?: number } };
  const input = event.tool_input ?? {};
  if (event.tool_name === "Grep" || (event.tool_name === "Bash" && SEARCH_COMMAND.test(input.command ?? ""))) {
    emit("PreToolUse", GREP_CONTEXT);
  } else if (event.tool_name === "Read" && input.file_path && input.offset === undefined && input.limit === undefined) {
    if (statSync(input.file_path).size > BIG_FILE_BYTES) emit("PreToolUse", READ_CONTEXT);
  }
}

function setSwitch(enabled: boolean) {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(SWITCH, JSON.stringify({ enabled }));
}

function status(): string {
  const lines = [`jev: ${isSwitchedOn(SWITCH) ? "on" : "off"}`];
  let entries: { tool?: string; ok?: boolean; input_tokens?: number; cost?: number; ms?: number; reason?: string }[];
  try {
    entries = readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [...lines, "no calls yet"].join("\n");
  }
  const refused = entries.filter((e) => e.reason === "disabled").length;
  const ok = entries.filter((e) => e.ok);
  const sum = (key: "input_tokens" | "cost" | "ms") => ok.reduce((n, e) => n + (e[key] ?? 0), 0);
  const byTool = new Map<string, number>();
  for (const e of ok) byTool.set(e.tool ?? "unknown", (byTool.get(e.tool ?? "unknown") ?? 0) + 1);
  lines.push(
    `calls: ${ok.length} ok, ${entries.length - ok.length - refused} failed, ${refused} refused while off`,
    `tokens: ${sum("input_tokens")}`,
    `cost: $${sum("cost").toFixed(6)}`,
    `avg latency: ${ok.length ? Math.round(sum("ms") / ok.length) : 0} ms`,
    `by tool: ${[...byTool].sort((a, b) => b[1] - a[1]).map(([tool, n]) => `${tool} ${n}`).join(" · ") || "none"}`,
  );
  return lines.join("\n");
}

const command = process.argv[2];
switch (command) {
  case "on":
    setSwitch(true);
    console.log("jev: on\nWhile on, the files and text Claude sends to the jev tools go to TypeSafe (through OpenRouter with an OpenRouter key). Keep it off for private work.");
    break;
  case "off":
    setSwitch(false);
    console.log("jev: off");
    break;
  case "status":
    console.log(status());
    break;
  case "prompt-hook":
  case "tool-hook":
    // A hook must never break the session: any failure means no nudge.
    try {
      if (!isSwitchedOn(SWITCH)) break;
      if (command === "prompt-hook") emit("UserPromptSubmit", PROMPT_CONTEXT);
      else toolHook(readFileSync(0, "utf8"));
    } catch {
      // silent
    }
    break;
  default:
    console.error("usage: jev on | off | status | prompt-hook | tool-hook");
    process.exit(2);
}
