/**
 * ripgrep as jev_search's file walker and line matcher.
 *
 * rg brings git's full ignore rules, skips hidden and binary files, never
 * follows symlinks, and matches in linear time, so a caller's pattern cannot
 * hang the server. It runs with an argument list (no shell) and --no-config,
 * so a user's ripgrep config cannot change what gets searched.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface RgMatch {
  /** Path relative to the searched directory, `/`-separated. */
  path: string;
  line: number;
  text: string;
  /** Neighbouring lines rg reported, in order, excluding the match itself. */
  context: string[];
}

export interface RgOptions {
  rgPath: string;
  cwd: string;
  pattern: string;
  ignoreCase: boolean;
  globs: readonly string[];
  context: number;
  maxFileSize: number;
  /** Stop and fail once more than this many lines match. */
  limit: number;
  signal: AbortSignal;
}

type RgMessage = {
  type: string;
  data: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; stats?: { searches_with_match?: number } };
};

export async function ripgrep(options: RgOptions): Promise<{ matches: RgMatch[]; filesMatched: number }> {
  const args = [
    "--json",
    "--no-config",
    "--no-require-git",
    "--context", String(options.context),
    "--max-filesize", String(options.maxFileSize),
    ...(options.ignoreCase ? ["--ignore-case"] : []),
    ...options.globs.flatMap((glob) => ["--glob", glob]),
    "--regexp", options.pattern,
    ".",
  ];
  const child = spawn(options.rgPath, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], signal: options.signal });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  // Settles, never rejects: a spawn error arrives while stdout is still being
  // read, and a rejection nobody awaits yet would take the whole server down.
  const exited = new Promise<{ code: number | null } | { error: NodeJS.ErrnoException }>((resolve) => {
    child.on("error", (error) => resolve({ error }));
    child.on("close", (code) => resolve({ code }));
  });

  // Lines per file, so each match can be given its neighbours once rg is done.
  const lines = new Map<string, Map<number, string>>();
  const found: { path: string; line: number }[] = [];
  let filesMatched = 0;
  let overLimit = false;
  for await (const raw of createInterface({ input: child.stdout })) {
    const message = JSON.parse(raw) as RgMessage;
    if (message.type === "summary") filesMatched = message.data.stats?.searches_with_match ?? 0;
    if (message.type !== "match" && message.type !== "context") continue;
    const path = message.data.path?.text?.replace(/^\.\//, "");
    const text = message.data.lines?.text;
    const line = message.data.line_number;
    if (path === undefined || text === undefined || line === undefined) continue; // non-UTF-8 path
    if (!lines.has(path)) lines.set(path, new Map());
    lines.get(path)!.set(line, text.replace(/\r?\n$/, ""));
    if (message.type === "match") {
      found.push({ path, line });
      if (found.length > options.limit) {
        overLimit = true;
        child.kill();
        break;
      }
    }
  }

  const exit = await exited;
  if ("error" in exit) {
    if (exit.error.code === "ENOENT") {
      throw new Error(`jev_search needs ripgrep: '${options.rgPath}' was not found. Install ripgrep (brew install ripgrep, apt install ripgrep) or set JEV_RG_PATH.`);
    }
    throw exit.error;
  }
  if (overLimit) throw new Error(`More than ${options.limit} lines match. Narrow it with pattern, include or dir.`);
  // 1 means no match. 2 with output means some files could not be read; the rest stand.
  if (exit.code === 2 && found.length === 0) throw new Error(`Invalid pattern or search failed: ${stderr.trim().split("\n")[0]}`);

  // rg searches files in parallel; order the result so windows are reproducible.
  found.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  const matches = found.map(({ path, line }) => {
    const file = lines.get(path)!;
    const context: string[] = [];
    for (let n = line - options.context; n <= line + options.context; n += 1) {
      const text = file.get(n);
      if (n !== line && text !== undefined && text.trim() !== "") context.push(text);
    }
    return { path, line, text: file.get(line)!, context };
  });
  return { matches, filesMatched };
}
