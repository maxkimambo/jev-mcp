#!/usr/bin/env node
/**
 * The plugin's side of jev: `/jev:jev on|off|status`, plus two Claude Code hooks
 * that route the agent to the jev tools. Context alone proved too weak: it arrives
 * after the search has already run. So the first search of each prompt is refused
 * toward jev_search, and any later one runs, which keeps exact-string lookups and
 * fallbacks one step away. Hooks stay silent while the switch is off.
 *
 * State lives in JEV_HOME (default ~/.claude/jev-think): `state.json` is the
 * switch the MCP server reads as JEV_SWITCH_FILE, `ledger.jsonl` its JEV_LEDGER.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSwitchedOn } from "./ops.js";

const HOME = process.env.JEV_HOME ?? join(homedir(), ".claude", "jev-think");
const SWITCH = join(HOME, "state.json");
const LEDGER = join(HOME, "ledger.jsonl");
/**
 * One marker per session, present from a prompt until its first search or jev
 * call, and a `.web` marker from a WebSearch until the next WebFetch.
 */
const TURNS = join(HOME, "turns");

/** Whole-file reads above this size are worth a nudge; roughly 400 lines of code. */
const BIG_FILE_BYTES = 16_000;
/** A search starts a command; after a pipe, rg or grep only filters another command's output. */
const SEARCH_COMMAND = /(^|[;&(]\s*)(rg|grep|ag|ack)\s/;

const TOOLS = "mcp__plugin_jev_jev__* (load with ToolSearch \"jev\" if deferred)";

const PROMPT_CONTEXT =
  `jev is ON. Before reading piles of text to orient or decide, let Jev read them and read only its answers (${TOOLS}): ` +
  "jev_search for lines across a directory instead of grep/rg (your first grep/rg this turn is refused unless a jev tool ran first), jev_locate for lines in one big file (both take all your questions in one call), " +
  "jev_ask with paths for questions about a few files, jev_extract for values from a file (all in one call), jev_screen before reading untrusted text. " +
  "Say in one line when Jev saved you a read.";

const SEARCH_REFUSAL =
  `jev is ON, so the first search of a turn goes to jev_search (${TOOLS}): pass dir, this pattern made broad, and every question you have as questions (batch them: extra questions cost almost nothing). ` +
  "It returns only the best path:line hits. If jev fails or you need an exact-string match, run this search again; it will be allowed."

const WEB_REFUSAL =
  `jev is ON: before fetching search results, pass all their URLs and every question you have to jev_rank_pages (${TOOLS}). ` +
  "It fetches the pages itself and returns which page answers each question; then WebFetch only that page. If jev fails, fetch again; it will be allowed."

const READ_CONTEXT =
  "jev is ON and this is a large file read whole: if you only need part of it, jev_locate returns the lines that answer your question, " +
  "and jev_extract returns a single value, without the file entering your context. Read it normally if you are going to edit it.";

function emit(output: Record<string, string>) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: output }));
}

function parse(raw: string): { session_id?: unknown; tool_name?: string; tool_input?: { command?: string; file_path?: string; offset?: number; limit?: number } } {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const turnMarker = (id: unknown) => (typeof id === "string" && /^[\w-]+$/.test(id) ? join(TURNS, id) : undefined);

function promptHook(raw: string) {
  emit({ hookEventName: "UserPromptSubmit", additionalContext: PROMPT_CONTEXT });
  const marker = turnMarker(parse(raw).session_id);
  if (!marker) return;
  mkdirSync(TURNS, { recursive: true });
  writeFileSync(marker, "");
  rmSync(`${marker}.web`, { force: true });
}

function toolHook(raw: string) {
  const event = parse(raw);
  const input = event.tool_input ?? {};
  const marker = turnMarker(event.session_id);
  if (event.tool_name?.startsWith("mcp__plugin_jev_jev__")) {
    if (!marker) return;
    rmSync(marker, { force: true });
    rmSync(`${marker}.web`, { force: true });
  } else if (event.tool_name === "WebSearch") {
    if (marker && existsSync(TURNS)) writeFileSync(`${marker}.web`, "");
  } else if (event.tool_name === "WebFetch") {
    if (!marker || !existsSync(`${marker}.web`)) return;
    rmSync(`${marker}.web`);
    emit({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: WEB_REFUSAL });
  } else if (event.tool_name === "Grep" || (event.tool_name === "Bash" && SEARCH_COMMAND.test(input.command ?? ""))) {
    if (!marker || !existsSync(marker)) return;
    rmSync(marker);
    emit({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: SEARCH_REFUSAL });
  } else if (event.tool_name === "Read" && input.file_path && input.offset === undefined && input.limit === undefined) {
    if (statSync(input.file_path).size > BIG_FILE_BYTES) emit({ hookEventName: "PreToolUse", additionalContext: READ_CONTEXT });
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
      const raw = readFileSync(0, "utf8");
      if (command === "prompt-hook") promptHook(raw);
      else toolHook(raw);
    } catch {
      // silent
    }
    break;
  default:
    console.error("usage: jev on | off | status | prompt-hook | tool-hook");
    process.exit(2);
}
