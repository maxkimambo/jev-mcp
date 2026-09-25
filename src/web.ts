/**
 * Fetching pages for jev_rank_pages. The URLs come from search results, so they
 * are untrusted: only https, and never a private, loopback or link-local
 * address. The address is checked inside the socket's own DNS lookup, so what
 * is checked is what gets connected to, and every redirect is checked again.
 */

import { execFile } from "node:child_process";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIPv4, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv6");
}

/** The IPv4 address inside an IPv4-mapped IPv6 address, in either notation. */
function unmapV4(ip: string): string | undefined {
  const mapped = /^::ffff:(.+)$/i.exec(ip)?.[1];
  if (!mapped) return undefined;
  if (isIPv4(mapped)) return mapped;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(mapped);
  if (!hex) return undefined;
  const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function isPublicAddress(ip: string): boolean {
  const v4 = isIPv4(ip) ? ip : unmapV4(ip);
  return v4 ? !PRIVATE.check(v4, "ipv4") : !PRIVATE.check(ip, "ipv6");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// ponytail: regex HTML stripping, good enough to judge relevance; a real parser if pages ever need structure.
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer|pre|blockquote|table|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (code[0] === "#") {
        const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : entity;
      }
      return ENTITIES[code.toLowerCase()] ?? entity;
    })
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export interface FetchOptions {
  /** Hosts exempt from the public-address rule, which may also use plain http. */
  allowHosts: ReadonlySet<string>;
  signal: AbortSignal;
  maxBytes?: number;
  /** markitdown binary, for PDF and Office pages. */
  markitdown?: string;
  /** trafilatura binary, to keep only the main content of HTML pages. */
  trafilatura?: string;
}

export interface Page {
  /** The URL the content came from, after redirects. */
  url: string;
  text: string;
}

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 5_000_000;
const TEXT_TYPES = /^(text\/(markdown|plain|x-markdown)|application\/(json|xml)|text\/xml)$/;
const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)$/;
const OFFICE = "application/vnd.openxmlformats-officedocument";
/** Types markitdown turns into markdown, with the extension it expects. */
const DOCUMENT_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  [`${OFFICE}.wordprocessingml.document`]: "docx",
  [`${OFFICE}.presentationml.presentation`]: "pptx",
  [`${OFFICE}.spreadsheetml.sheet`]: "xlsx",
};
const CONVERTER_TIMEOUT_MS = 30_000;

/**
 * Run a converter CLI over bytes we already fetched, through its stdin, so it
 * never fetches anything past the address guard itself.
 */
function convert(bin: string, args: string[], body: Buffer, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { signal, timeout: CONVERTER_TIMEOUT_MS, maxBuffer: 50_000_000, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      reject(Object.assign(new Error(stderr.trim().split("\n").pop() || error.message), { code: (error as NodeJS.ErrnoException).code }));
    });
    child.stdin?.on("error", () => {}); // a converter that exits early closes stdin; its exit code reports why
    child.stdin?.end(body);
  });
}

async function markitdown(bin: string, body: Buffer, type: string, signal: AbortSignal): Promise<string> {
  try {
    return await convert(bin, ["-m", type, "-x", DOCUMENT_TYPES[type]!], body, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`PDF and Office pages need markitdown: uv tool install 'markitdown[pdf,docx,pptx,xlsx]', or set JEV_MARKITDOWN_PATH.`);
    }
    throw new Error(`markitdown could not convert the page: ${(error as Error).message}`);
  }
}

/**
 * The page's main content without menus, footers and ads, favouring recall: a
 * missed answer costs more than a little noise. Falls back to plain text when
 * trafilatura is missing, fails, or finds no main content.
 */
async function mainContent(bin: string | undefined, html: string, signal: AbortSignal): Promise<string> {
  if (bin) {
    try {
      const markdown = (await convert(bin, ["--output-format", "markdown", "--no-comments", "--recall"], Buffer.from(html), signal)).trim();
      if (markdown) return markdown;
    } catch {
      // plain text below
    }
  }
  return htmlToText(html);
}

function guardedLookup(allowHosts: ReadonlySet<string>): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) return callback(error, "", 0);
      if (!allowHosts.has(hostname) && addresses.some((a) => !isPublicAddress(a.address))) {
        return callback(new Error(`${hostname} resolves to a private address; refusing to fetch it.`), "", 0);
      }
      if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

function get(url: URL, options: FetchOptions): Promise<IncomingMessage> {
  const plain = url.protocol === "http:";
  if (url.protocol !== "https:" && !(plain && options.allowHosts.has(url.hostname))) {
    return Promise.reject(new Error(`Only https URLs are fetched: ${url.href}`));
  }
  // A literal IP skips DNS, so check it here as well.
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (!options.allowHosts.has(url.hostname) && (isIPv4(literal) || literal.includes(":")) && !isPublicAddress(literal)) {
    return Promise.reject(new Error(`${url.hostname} is a private address; refusing to fetch it.`));
  }
  return new Promise((resolve, reject) => {
    const req = (plain ? httpRequest : httpsRequest)(
      url,
      {
        signal: options.signal,
        lookup: guardedLookup(options.allowHosts),
        headers: {
          accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8",
          "accept-encoding": "gzip, deflate, br",
          "user-agent": "jev-mcp (+https://github.com/maxkimambo/jev-mcp)",
        },
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

async function readBody(res: IncomingMessage, url: string, maxBytes: number): Promise<Buffer> {
  const encoding = res.headers["content-encoding"];
  const stream =
    encoding === "gzip" ? res.pipe(createGunzip()) : encoding === "br" ? res.pipe(createBrotliDecompress()) : encoding === "deflate" ? res.pipe(createInflate()) : res;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      res.destroy();
      throw new Error(`${url} is larger than ${maxBytes} bytes.`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Fetch one page as text: markdown or plain text as served, HTML reduced to its text. */
export async function fetchPage(href: string, options: FetchOptions): Promise<Page> {
  let url = new URL(href);
  for (let hop = 0; ; hop++) {
    const res = await get(url, options);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop === MAX_REDIRECTS) throw new Error(`${href} redirects more than ${MAX_REDIRECTS} times.`);
      url = new URL(res.headers.location, url);
      continue;
    }
    if (status !== 200) {
      res.resume();
      throw new Error(`${url.href} answered HTTP ${status}.`);
    }
    const [type = "", ...params] = (res.headers["content-type"] ?? "").split(";").map((s) => s.trim().toLowerCase());
    if (!TEXT_TYPES.test(type) && !HTML_TYPES.test(type) && !DOCUMENT_TYPES[type]) {
      res.resume();
      throw new Error(`${url.href} is ${type || "an unknown type"}, not a text page.`);
    }
    const body = await readBody(res, url.href, options.maxBytes ?? DEFAULT_MAX_BYTES);
    if (DOCUMENT_TYPES[type]) return { url: url.href, text: await markitdown(options.markitdown ?? "markitdown", body, type, options.signal) };
    const charset = params.find((p) => p.startsWith("charset="))?.slice(8);
    let raw: string;
    try {
      raw = new TextDecoder(charset || "utf-8").decode(body);
    } catch {
      raw = new TextDecoder("utf-8").decode(body);
    }
    return { url: url.href, text: HTML_TYPES.test(type) ? await mainContent(options.trafilatura, raw, options.signal) : raw };
  }
}
