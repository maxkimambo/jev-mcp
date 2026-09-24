/**
 * Operator controls that live outside any single call: an on/off switch and a
 * usage ledger. Both are opt-in through the environment, so a server started
 * without them behaves exactly as before.
 *
 *  - JEV_SWITCH_FILE: a JSON file `{"enabled": true|false}`. When set, the tools
 *    that send content refuse to run unless it says enabled, and a missing or
 *    unreadable file counts as off. This lets one switch cover every agent that
 *    shares the file, and keeps "send my files to a third party" a decision the
 *    user makes, not the model.
 *  - JEV_LEDGER: a JSONL file. One line per tool call with usage and cost, never
 *    any state, question, or file content.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Jev's list price per input token, used when the gateway reports no cost. */
const PRICE_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export function isSwitchedOn(file: string | undefined): boolean {
  if (!file) return true;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

export interface LedgerEntry {
  tool: string;
  ok: boolean;
  /** How many questions were sent to the API across every request of the call. */
  questions: number;
  input_tokens: number;
  /** As reported by the gateway (OpenRouter does), else estimated from list price. */
  cost?: number;
  ms: number;
  client?: string;
  reason?: string;
}

export function appendLedger(file: string | undefined, entry: LedgerEntry): void {
  if (!file) return;
  const cost = entry.cost ?? entry.input_tokens * PRICE_PER_INPUT_TOKEN;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry, cost }) + "\n");
  } catch (error) {
    // Bookkeeping must never fail a judgment.
    console.error(`[jev-mcp] could not write ledger ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
