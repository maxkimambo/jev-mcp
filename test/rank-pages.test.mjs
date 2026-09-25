// jev_rank_pages: fetch search-result pages server-side, rank them per question,
// and return the lines of the best page that answer it, so the agent rarely has
// to fetch a page at all. Pages come from a local server allowed through
// JEV_ALLOW_HOSTS; the stand-in API judges them and always picks the first line.

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { segmentLines } from "../dist/lib.js";
import { payload, startMock, withClient } from "./helpers.mjs";

const CLEAN = { screen_override: 0.01, screen_exfiltrate: 0.01, screen_hidden: 0.01 };

async function site({ delayMs = 0 } = {}) {
  let inFlight = 0;
  const stats = { maxInFlight: 0 };
  const server = createServer(async (req, res) => {
    stats.maxInFlight = Math.max(stats.maxInFlight, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    inFlight--;
    const pages = {
      "/retries.md": ["text/markdown", "# Retries\nThe client retries 3 times with backoff.\n"],
      "/long.md": ["text/markdown", `# Laya\n${"Laya is a decision model. It scores 0.08 ECE after calibration! Zero-shot accuracy lags Jev by 11 points. ".repeat(3)}`],
      "/about": ["text/html", "<html><script>SECRET_SCRIPT()</script><body><p>About us</p></body></html>"],
    };
    const page = pages[req.url] ?? (req.url.startsWith("/p") ? ["text/plain", `page ${req.url}`] : undefined);
    if (!page) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": page[0] }).end(page[1]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, stats, close: () => new Promise((resolve) => server.close(resolve)) };
}

const env = { JEV_ALLOW_HOSTS: "127.0.0.1" };

test("jev_rank_pages ranks pages per question and returns the answering lines of the best page", async () => {
  const pages = await site();
  const mock = await startMock();
  try {
    mock.state.noul = 0.9;
    mock.state.noulById = CLEAN;
    await withClient({ baseUrl: mock.url, env }, async (client) => {
      const urls = [`${pages.base}/retries.md`, `${pages.base}/about`, `${pages.base}/gone`];
      const questions = ["How many times does the client retry?", "Does it back off?"];
      const result = await client.callTool({ name: "jev_rank_pages", arguments: { urls, questions } });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));

      const [first, second, lines] = mock.requests.map((r) => r.body);
      for (const ranking of [first, second]) {
        assert.deepEqual(Object.keys(ranking.questions), ["q1", "q2", "screen_override", "screen_exfiltrate", "screen_hidden"], "injection checks ride along");
        assert.ok(!ranking.state.includes("SECRET_SCRIPT"), "scripts never reach Jev");
      }
      assert.equal(mock.requests.length, 3, "one ranking request per page, then one line request for the page both questions picked");
      assert.deepEqual(Object.keys(lines.questions), ["q1_where", "q1_exists", "q2_where", "q2_exists"]);
      assert.match(lines.state, /^L0001\| # Retries\nL0002\| The client retries 3 times/);

      const out = payload(result);
      assert.deepEqual(out.pages, urls, "URLs appear once; everything else refers to them by index");
      assert.deepEqual(out.failed.map((f) => f.page), [2]);
      assert.match(out.failed[0].error, /HTTP 404/);
      assert.deepEqual(out.suspicious, []);
      for (const [i, r] of out.results.entries()) {
        assert.equal(r.question, questions[i]);
        assert.deepEqual(r.ranking, [{ page: 0, probability: 0.9, found: "yes" }, { page: 1, probability: 0.9, found: "yes" }]);
        assert.equal(r.answer.page, 0);
        assert.deepEqual(r.answer.lines[0], { line: 1, text: "# Retries" });
      }
    });
  } finally {
    await mock.close();
    await pages.close();
  }
});

test("segmentLines breaks long lines at sentence ends and keeps each piece's source line", () => {
  assert.deepEqual(segmentLines("# T\n\nShort line.\nOne. Two! Three?", 8), [
    { line: 1, text: "# T" },
    { line: 3, text: "Short" },
    { line: 3, text: "line." },
    { line: 4, text: "One." },
    { line: 4, text: "Two!" },
    { line: 4, text: "Three?" },
  ]);
  assert.deepEqual(segmentLines("abcdefghij", 4).map((s) => s.text), ["abcd", "efgh", "ij"], "no sentence end: hard split");
  assert.deepEqual(segmentLines("One. Two.", 20), [{ line: 1, text: "One. Two." }], "short lines stay whole");
});

test("jev_rank_pages answers with sentences, not whole lines, when a page puts paragraphs on one line", async () => {
  const pages = await site();
  const mock = await startMock();
  try {
    mock.state.noul = 0.9;
    mock.state.noulById = CLEAN;
    await withClient({ baseUrl: mock.url, env }, async (client) => {
      const out = payload(await client.callTool({ name: "jev_rank_pages", arguments: { urls: [`${pages.base}/long.md`], questions: ["What is Laya's ECE?"] } }));
      const lines = mock.requests.at(-1).body.state.split("\n");
      assert.equal(lines[1], "L0002| Laya is a decision model.");
      assert.ok(lines.every((l) => l.length <= 320), "every candidate is sentence-sized");
      assert.deepEqual(out.results[0].answer.lines[0], { line: 1, text: "# Laya" });
      assert.ok(out.results[0].answer.lines.every((l) => l.text.length <= 300));
    });
  } finally {
    await mock.close();
    await pages.close();
  }
});

test("tool results are compact JSON, since every indent costs the agent context", async () => {
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      const result = await client.callTool({ name: "jev_check", arguments: { state: "s", question: "q" } });
      assert.ok(!result.content[0].text.includes("\n"), result.content[0].text.slice(0, 80));
    });
  } finally {
    await mock.close();
  }
});

test("jev_rank_pages withholds the lines of a page that tries to steer the agent", async () => {
  const pages = await site();
  const mock = await startMock();
  try {
    mock.state.noul = 0.9;
    mock.state.noulById = { ...CLEAN, screen_override: 0.95 };
    await withClient({ baseUrl: mock.url, env }, async (client) => {
      const out = payload(await client.callTool({ name: "jev_rank_pages", arguments: { urls: [`${pages.base}/retries.md`], questions: ["q?"] } }));
      assert.deepEqual(out.suspicious, [0]);
      assert.equal(out.results[0].ranking[0].page, 0, "still ranked, so the agent can decide to fetch it");
      assert.equal(out.results[0].answer, null);
      assert.equal(mock.requests.length, 1, "no line request for a suspicious page");
    });
  } finally {
    await mock.close();
    await pages.close();
  }
});

test("jev_rank_pages gives no answer when no page answers, and ranks at most three pages", async () => {
  const pages = await site();
  const mock = await startMock();
  try {
    mock.state.noul = 0.1;
    mock.state.noulById = CLEAN;
    await withClient({ baseUrl: mock.url, env }, async (client) => {
      const urls = ["/p1", "/p2", "/p3", "/p4"].map((p) => pages.base + p);
      const out = payload(await client.callTool({ name: "jev_rank_pages", arguments: { urls, questions: ["q?"] } }));
      assert.equal(out.results[0].ranking.length, 3);
      assert.equal(out.results[0].ranking[0].found, "no");
      assert.equal(out.results[0].answer, null);
      assert.equal(mock.requests.length, 4, "ranking only");
    });
  } finally {
    await mock.close();
    await pages.close();
  }
});

test("jev_rank_pages fetches every page at once, whatever the Jev concurrency", async () => {
  const pages = await site({ delayMs: 150 });
  const mock = await startMock();
  try {
    mock.state.noulById = CLEAN;
    await withClient({ baseUrl: mock.url, env: { ...env, JEV_CONCURRENCY: "2" } }, async (client) => {
      const urls = Array.from({ length: 8 }, (_, i) => `${pages.base}/p${i}`);
      await client.callTool({ name: "jev_rank_pages", arguments: { urls, questions: ["q?"] } });
      assert.equal(pages.stats.maxInFlight, 8);
    });
  } finally {
    await mock.close();
    await pages.close();
  }
});

test("jev_rank_pages refuses private addresses unless allowed, and sends nothing for them", async () => {
  const pages = await site();
  const mock = await startMock();
  try {
    await withClient({ baseUrl: mock.url }, async (client) => {
      const out = payload(await client.callTool({ name: "jev_rank_pages", arguments: { urls: [`${pages.base}/retries.md`, "https://192.168.0.21/"], questions: ["q?"] } }));
      assert.match(out.failed[0].error, /https/);
      assert.match(out.failed[1].error, /private address/);
      assert.deepEqual(out.results[0].ranking, []);
      assert.equal(out.results[0].answer, null);
      assert.equal(mock.requests.length, 0);
    });
  } finally {
    await mock.close();
    await pages.close();
  }
});

test("jev_rank_pages takes real URLs only, at most 20", async () => {
  await withClient({ withKey: false }, async (client) => {
    for (const urls of [["not a url"], Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`)]) {
      const result = await client.callTool({ name: "jev_rank_pages", arguments: { urls, questions: ["q?"] } });
      assert.equal(result.isError, true, JSON.stringify(urls).slice(0, 40));
    }
  });
});
