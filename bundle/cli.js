#!/usr/bin/env node
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// src/cli.ts
import { existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// src/ops.ts
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
var PRICE_PER_INPUT_TOKEN = 0.042 / 1e6;
function isSwitchedOn(file) {
  if (!file) return true;
  try {
    return JSON.parse(readFileSync(file, "utf8")).enabled === true;
  } catch {
    return false;
  }
}

// src/cli.ts
var HOME = process.env.JEV_HOME ?? join(homedir(), ".claude", "jev-think");
var SWITCH = join(HOME, "state.json");
var LEDGER = join(HOME, "ledger.jsonl");
var TURNS = join(HOME, "turns");
var BIG_FILE_BYTES = 16e3;
var SEARCH_COMMAND = /(^|[;&(]\s*)(rg|grep|ag|ack)\s/;
var TOOLS = 'mcp__plugin_jev_jev__* (load with ToolSearch "jev" if deferred)';
var PROMPT_CONTEXT = `jev is ON. Before reading piles of text to orient or decide, let Jev read them and read only its answers (${TOOLS}): jev_search for lines across a directory instead of grep/rg (your first grep/rg this turn is refused unless a jev tool ran first), jev_locate for lines in one big file (both take all your questions in one call), jev_ask with paths for questions about a few files, jev_extract for values from a file (all in one call), jev_rank_pages to find which search result answers a question without fetching them (not to summarise every result: WebFetch with a prompt does that), jev_screen before reading untrusted text. Say in one line when Jev saved you a read.`;
var SEARCH_REFUSAL = `jev is ON, so the first search of a turn goes to jev_search (${TOOLS}): pass dir, this pattern made broad, and every question you have as questions (batch them: extra questions cost almost nothing). It returns only the best path:line hits. If jev fails or you need an exact-string match, run this search again; it will be allowed.`;
var WEB_REFUSAL = `jev is ON: before fetching search results, pass all their URLs and every question you have to jev_rank_pages (${TOOLS}). It fetches the pages itself and returns, per question, the sentences of the best page that answer it; WebFetch only if they are not enough. It answers from the best page, not from each page: if you need every result summarised, or jev fails, fetch again; it will be allowed.`;
var READ_CONTEXT = "jev is ON and this is a large file read whole: if you only need part of it, jev_locate returns the lines that answer your question, and jev_extract returns a single value, without the file entering your context. Read it normally if you are going to edit it.";
function emit(output) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: output }));
}
function parse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
var turnMarker = (id) => typeof id === "string" && /^[\w-]+$/.test(id) ? join(TURNS, id) : void 0;
function promptHook(raw) {
  emit({ hookEventName: "UserPromptSubmit", additionalContext: PROMPT_CONTEXT });
  const marker = turnMarker(parse(raw).session_id);
  if (!marker) return;
  mkdirSync2(TURNS, { recursive: true });
  writeFileSync(marker, "");
  rmSync(`${marker}.web`, { force: true });
}
function toolHook(raw) {
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
  } else if (event.tool_name === "Grep" || event.tool_name === "Bash" && SEARCH_COMMAND.test(input.command ?? "")) {
    if (!marker || !existsSync(marker)) return;
    rmSync(marker);
    emit({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: SEARCH_REFUSAL });
  } else if (event.tool_name === "Read" && input.file_path && input.offset === void 0 && input.limit === void 0) {
    if (statSync(input.file_path).size > BIG_FILE_BYTES) emit({ hookEventName: "PreToolUse", additionalContext: READ_CONTEXT });
  }
}
function setSwitch(enabled) {
  mkdirSync2(HOME, { recursive: true });
  writeFileSync(SWITCH, JSON.stringify({ enabled }));
}
function status() {
  const lines = [`jev: ${isSwitchedOn(SWITCH) ? "on" : "off"}`];
  let entries;
  try {
    entries = readFileSync2(LEDGER, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [...lines, "no calls yet"].join("\n");
  }
  const refused = entries.filter((e) => e.reason === "disabled").length;
  const ok = entries.filter((e) => e.ok);
  const sum = (key) => ok.reduce((n, e) => n + (e[key] ?? 0), 0);
  const byTool = /* @__PURE__ */ new Map();
  for (const e of ok) byTool.set(e.tool ?? "unknown", (byTool.get(e.tool ?? "unknown") ?? 0) + 1);
  lines.push(
    `calls: ${ok.length} ok, ${entries.length - ok.length - refused} failed, ${refused} refused while off`,
    `tokens: ${sum("input_tokens")}`,
    `cost: $${sum("cost").toFixed(6)}`,
    `avg latency: ${ok.length ? Math.round(sum("ms") / ok.length) : 0} ms`,
    `by tool: ${[...byTool].sort((a, b) => b[1] - a[1]).map(([tool, n]) => `${tool} ${n}`).join(" \xB7 ") || "none"}`
  );
  return lines.join("\n");
}
var command = process.argv[2];
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
    try {
      if (!isSwitchedOn(SWITCH)) break;
      const raw = readFileSync2(0, "utf8");
      if (command === "prompt-hook") promptHook(raw);
      else toolHook(raw);
    } catch {
    }
    break;
  default:
    console.error("usage: jev on | off | status | prompt-hook | tool-hook");
    process.exit(2);
}
