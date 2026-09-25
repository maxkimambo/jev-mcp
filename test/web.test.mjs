// src/web.ts: fetching pages for jev_rank_pages. Search results are untrusted
// URLs, so the fetcher must never reach a private address, even via a redirect.

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPage, htmlToText, isPublicAddress } from "../dist/web.js";

async function pageServer() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, accept: req.headers.accept });
    const { port } = server.address();
    const routes = {
      "/md": [200, "text/markdown; charset=utf-8", "# Retries\n\nThe client retries 3 times."],
      "/html": [200, "text/html", "<html><head><style>p{}</style><script>steal()</script></head><body><h1>Title</h1><p>Tom &amp; Jerry&nbsp;&#39;s page</p><!-- note --></body></html>"],
      "/png": [200, "image/png", "\x89PNG"],
      "/big": [200, "text/plain", "x".repeat(2_000)],
      "/doc.pdf": [200, "application/pdf", "%PDF-1.4 fake"],
    };
    if (req.url === "/moved") return res.writeHead(302, { location: "/md" }).end();
    if (req.url === "/to-private") return res.writeHead(302, { location: `http://localhost:${port}/md` }).end();
    const route = routes[req.url];
    if (!route) return res.writeHead(404).end("missing");
    res.writeHead(route[0], { "content-type": route[1] }).end(route[2]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

const allow = new Set(["127.0.0.1"]);
const signal = () => AbortSignal.timeout(5_000);

test("isPublicAddress refuses private, loopback, link-local and mapped addresses", () => {
  for (const ip of ["10.0.0.1", "172.16.3.4", "192.168.0.21", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:192.168.0.1", "::ffff:7f00:1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPublicAddress(ip), true, ip);
});

test("htmlToText keeps the words and drops script, style and comments", () => {
  const text = htmlToText("<style>p{}</style><script>steal()</script><h1>Title</h1><p>Tom &amp; Jerry&nbsp;&#39;s &#x41;</p><!-- note -->");
  assert.equal(text, "Title\nTom & Jerry 's A");
});

test("fetchPage asks for markdown, follows redirects, and turns HTML into text", async () => {
  const site = await pageServer();
  try {
    const md = await fetchPage(`${site.base}/moved`, { allowHosts: allow, signal: signal() });
    assert.equal(md.url, `${site.base}/md`);
    assert.match(md.text, /retries 3 times/);
    assert.match(site.seen[0].accept, /^text\/markdown/);

    const html = await fetchPage(`${site.base}/html`, { allowHosts: allow, signal: signal() });
    assert.equal(html.text, "Title\nTom & Jerry 's page");
  } finally {
    await site.close();
  }
});

test("fetchPage refuses what it cannot judge: errors, binaries, oversized pages", async () => {
  const site = await pageServer();
  try {
    await assert.rejects(fetchPage(`${site.base}/nope`, { allowHosts: allow, signal: signal() }), /HTTP 404/);
    await assert.rejects(fetchPage(`${site.base}/png`, { allowHosts: allow, signal: signal() }), /image\/png/);
    await assert.rejects(fetchPage(`${site.base}/big`, { allowHosts: allow, signal: signal(), maxBytes: 1_000 }), /larger than/);
  } finally {
    await site.close();
  }
});

test("fetchPage never reaches a private address, directly or through a redirect", async () => {
  const site = await pageServer();
  try {
    await assert.rejects(fetchPage(`${site.base}/md`, { allowHosts: new Set(), signal: signal() }), /https/, "plain http only for allowed hosts");
    await assert.rejects(fetchPage("https://127.0.0.1/", { allowHosts: new Set(), signal: signal() }), /private address/);
    await assert.rejects(fetchPage("https://localhost/", { allowHosts: new Set(), signal: signal() }), /private address/);
    await assert.rejects(fetchPage(`${site.base}/to-private`, { allowHosts: allow, signal: signal() }), /https/, "a redirect is checked like the first URL");
    assert.ok(!site.seen.some((r) => r.url === "/md"), "the redirect target was never fetched");
  } finally {
    await site.close();
  }
});

/** A stand-in for the markitdown CLI: echoes its arguments and how many bytes it read. */
function fakeMarkitdown() {
  const bin = join(mkdtempSync(join(tmpdir(), "jev-md-")), "markitdown");
  writeFileSync(bin, `#!${process.execPath}\nlet n = 0; process.stdin.on("data", (c) => (n += c.length)).on("end", () => console.log("# converted " + process.argv.slice(2).join(" ") + " from " + n + " bytes"));\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test("fetchPage hands PDF and Office pages to markitdown over stdin", async () => {
  const site = await pageServer();
  try {
    const page = await fetchPage(`${site.base}/doc.pdf`, { allowHosts: allow, signal: signal(), markitdown: fakeMarkitdown() });
    assert.equal(page.text.trim(), "# converted -m application/pdf -x pdf from 13 bytes");
  } finally {
    await site.close();
  }
});

test("fetchPage says how to install markitdown when a PDF needs it", async () => {
  const site = await pageServer();
  try {
    await assert.rejects(fetchPage(`${site.base}/doc.pdf`, { allowHosts: allow, signal: signal(), markitdown: "/nonexistent/markitdown" }), /uv tool install/);
  } finally {
    await site.close();
  }
});
