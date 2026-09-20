/**
 * Server-side file reads for `jev_triage`.
 *
 * A `path` item arrives from the model, and the model can be steered by text
 * it has read, so every path is untrusted. The rules:
 *
 *  1. A path must resolve inside an allowed root, checked lexically first and
 *     again after symlinks are resolved, so a link cannot walk out.
 *  2. Credential material is refused by name, wherever it sits inside a root.
 *  3. Only regular files are read. Binary content is refused.
 *  4. Oversized content is refused, never truncated, to match every other tool.
 *  5. No error message ever carries file contents.
 */

import { open, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { FileAccessError } from "./lib.js";

export interface ParsedRoots {
  roots: string[];
  /** Set when the raw value was present but unusable, so the caller can warn. */
  warning?: string;
}

/**
 * Parse `JEV_FILE_ROOTS`.
 *
 * Unset or empty means the working directory the server was started in. The
 * literal `off` disables `path` items entirely. Otherwise a `path.delimiter`
 * separated list of absolute directories; any relative entry rejects the whole
 * value and falls back to the working directory, with a warning.
 */
export function parseRoots(raw: string | undefined, cwd: string): ParsedRoots {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return { roots: [cwd] };
  if (trimmed.toLowerCase() === "off") return { roots: [] };
  const entries = trimmed.split(delimiter).map((e) => e.trim()).filter((e) => e.length > 0);
  const relativeEntry = entries.find((e) => !isAbsolute(e));
  if (relativeEntry !== undefined) {
    return { roots: [cwd], warning: `JEV_FILE_ROOTS entries must be absolute; got ${JSON.stringify(relativeEntry)}. Using the working directory ${cwd}.` };
  }
  return { roots: entries.map((e) => normalize(e)) };
}

/** True when `target` sits strictly below `root`. The root itself never qualifies. */
export function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Names that hold credentials. Matched against every path segment of both the
 * requested path and its symlink-resolved form. Deliberately a short, obvious
 * list: the goal is to stop an injected instruction from shipping a key to the
 * API, not to classify every file on disk.
 */
const DENIED_DIRS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".gcloud", ".password-store"]);
const DENIED_CONFIG_DIRS = new Set(["typesafe", "gh", "hub", "op", "1password", "gcloud"]);
const DENIED_FILES = [
  /^\.env(\..+)?$/,
  /^\.(netrc|npmrc|pypirc|htpasswd|git-credentials|pgpass|my\.cnf)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /^\.?(credentials?|secrets?)(\.[a-z0-9]+)?$/i,
];

/** True when any segment of `path` names credential material. */
export function isDeniedPath(path: string): boolean {
  const segments = normalize(path).split(sep).filter((s) => s.length > 0);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (DENIED_DIRS.has(segment)) return true;
    if (segment === ".config" && i + 1 < segments.length && DENIED_CONFIG_DIRS.has(segments[i + 1]!)) return true;
  }
  const base = segments[segments.length - 1];
  return base !== undefined && DENIED_FILES.some((re) => re.test(base));
}

export interface ReadOptions {
  roots: readonly string[];
  maxChars: number;
  /** Extra refusals beyond the built-in list, e.g. the server's own key file. */
  isDenied?: (path: string) => boolean;
}

const OUTSIDE_HINT = "Only files below JEV_FILE_ROOTS (default: the server's working directory) can be read. Pass the content as text if you have already read it.";

/**
 * Read a text file for judgment.
 *
 * Relative paths resolve against the first root. The lexical check runs before
 * anything touches the filesystem, so a path outside the roots gets the same
 * answer whether or not it exists.
 */
export async function readTextFile(requested: string, options: ReadOptions): Promise<string> {
  const { roots, maxChars } = options;
  const denied = (p: string) => isDeniedPath(p) || (options.isDenied?.(p) ?? false);

  if (roots.length === 0) {
    throw new FileAccessError("File reads are disabled (JEV_FILE_ROOTS=off).", "Pass the content as text, or set JEV_FILE_ROOTS to a directory.");
  }
  const lexical = isAbsolute(requested) ? normalize(requested) : resolve(roots[0]!, requested);
  if (!roots.some((root) => isWithinRoot(root, lexical))) {
    throw new FileAccessError(`Path is outside the allowed roots: ${requested}`, OUTSIDE_HINT);
  }
  if (denied(lexical)) {
    throw new FileAccessError(`Refused: ${requested} looks like credential material.`, "Credential files are never sent to the API. Choose another file.");
  }

  let real: string;
  try {
    real = await realpath(lexical);
  } catch {
    throw new FileAccessError(`File not found: ${requested}`, "Check the path. Relative paths resolve against the first allowed root.");
  }
  const realRoots = (await Promise.all(roots.map((root) => realpath(root).catch(() => undefined)))).filter((r): r is string => r !== undefined);
  if (!realRoots.some((root) => isWithinRoot(root, real))) {
    throw new FileAccessError(`Path is outside the allowed roots: ${requested}`, OUTSIDE_HINT);
  }
  if (denied(real)) {
    throw new FileAccessError(`Refused: ${requested} looks like credential material.`, "Credential files are never sent to the API. Choose another file.");
  }

  // Classify before opening. A read-only open of a FIFO blocks until a writer
  // appears, so a post-open check would never run and the call would hang.
  const notRegular = () => new FileAccessError(`Not a regular file: ${requested}`, "Only regular files can be read. List a directory yourself and pass each file.");
  if (!(await stat(real)).isFile()) throw notRegular();

  const handle = await open(real, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw notRegular();
    // Every UTF-8 sequence yields at least one UTF-16 unit per three bytes, so a
    // file above three times the limit cannot fit and is refused unread. Below
    // that the exact character count decides, after decoding.
    const oversized = (measure: string) =>
      new FileAccessError(
        `File is ${measure}, above the ${maxChars} character limit: ${requested}`,
        "Select the relevant part and pass it as text, or raise JEV_MAX_STATE_CHARS. Nothing is truncated.",
      );
    if (info.size > maxChars * 3) throw oversized(`${info.size} bytes`);
    const text = await handle.readFile("utf8");
    if (text.includes("\0")) {
      throw new FileAccessError(`Binary file: ${requested}`, "Only text files can be judged.");
    }
    if (text.length > maxChars) throw oversized(`${text.length} characters`);
    return text;
  } finally {
    await handle.close();
  }
}
