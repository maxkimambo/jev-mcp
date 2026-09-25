// jev_rank_pages: fetch search-result pages server-side and rank them per
// question, so the agent reads only the page that answers. Pages come from a
// local server allowed through JEV_ALLOW_HOSTS; the stand-in API judges them.

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { payload, startMock, withClient } from "./helpers.mjs";

async function site() {
  const server = createServer((req, res) => {
    const pages = {
      "/retries.md": ["text/markdown", "# Retries\n\nThe client retries 3 times with backoff."],
      "/about": ["text/html", "<html><script>SECRET_SCRIPT()</script><body><p>About us</p></body></html>"],
    };
    const page = pages[req.url];
    if (!page) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": page[0] }).end(page[1]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("jev_rank_pages fetches each page once, asks every question in one request, and ranks per question", async () => {
  const pages = await site();
  const mock = await startMock();
  try {
    mock.state.noul = 0.9;
    await withClient({ baseUrl: mock.url, env: { JEV_ALLOW_HOSTS: "127.0.0.1" } }, async (client) => {
      const urls = [`${pages.base}/retries.md`, `${pages.base}/about`, `${pages.base}/gone`];
      const questions = ["How many times does the client retry?", "Who wrote the client?"];
      const result = await client.callTool({ name: "jev_rank_pages", arguments: { urls, questions } });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));

      assert.equal(mock.requests.length, 2, "one request per fetched page, not per question");
      for (const { body } of mock.requests) {
        assert.deepEqual(Object.keys(body.questions), ["q1", "q2"]);
        assert.ok(Object.values(body.questions).every((q) => q.type === "noul"));
        assert.ok(!body.state.includes("SECRET_SCRIPT"), "scripts never reach Jev");
      }
      assert.ok(mock.requests.some(({ body }) => body.state.includes(urls[0]) && body.state.includes("retries 3 times")));

      const out = payload(result);
      assert.deepEqual(out.results.map((r) => r.question), questions);
      for (const r of out.results) {
        assert.deepEqual(r.pages.map((p) => p.url).sort(), urls.slice(0, 2).sort(), "only fetched pages are ranked");
        assert.ok(r.pages.every((p) => p.found === "yes" && p.probability === 0.9));
      }
      assert.match(out.pages[2].error, /HTTP 404/);
      assert.equal(out.pages[0].chars > 0, true);
      assert.ok(!JSON.stringify(out).includes("retries 3 times"), "page text never comes back");
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
      assert.match(out.pages[0].error, /https/);
      assert.match(out.pages[1].error, /private address/);
      assert.deepEqual(out.results[0].pages, []);
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
