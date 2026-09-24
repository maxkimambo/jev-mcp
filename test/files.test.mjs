// Unit tests for server-side file reads. Filesystem only, no network.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { isDeniedPath, isWithinRoot, parseRoots, readTextFile } from "../dist/files.js";
import { FileAccessError } from "../dist/lib.js";

test("parseRoots defaults to the working directory, honours 'off', and rejects relative entries", () => {
  assert.deepEqual(parseRoots(undefined, "/work"), { roots: ["/work"] });
  assert.deepEqual(parseRoots("  ", "/work"), { roots: ["/work"] });
  assert.deepEqual(parseRoots("off", "/work"), { roots: [] });
  assert.deepEqual(parseRoots(["/a", "/b/"].join(delimiter), "/work").roots, ["/a", "/b/"]);
  const bad = parseRoots(["/a", "relative"].join(delimiter), "/work");
  assert.deepEqual(bad.roots, ["/work"]);
  assert.match(bad.warning, /absolute/);
});

test("isWithinRoot admits descendants only, never the root itself or a sibling", () => {
  assert.equal(isWithinRoot("/r", "/r/a.txt"), true);
  assert.equal(isWithinRoot("/r", "/r/deep/er/a.txt"), true);
  assert.equal(isWithinRoot("/r", "/r"), false);
  assert.equal(isWithinRoot("/r", "/r/../x"), false);
  assert.equal(isWithinRoot("/r", "/rr/a.txt"), false, "a shared prefix is not containment");
  assert.equal(isWithinRoot("/r", "/other/a.txt"), false);
});

test("isDeniedPath refuses credential material and leaves ordinary code alone", () => {
  for (const denied of [
    "/home/u/.ssh/id_ed25519",
    "/home/u/.ssh/config",
    "/home/u/.aws/credentials",
    "/home/u/.config/typesafe/key",
    "/home/u/.config/jev/api_key",
    "/home/u/.config/gh/hosts.yml",
    "/p/.env",
    "/p/.env.local",
    "/p/.npmrc",
    "/p/server.key",
    "/p/cert.pem",
    "/p/CERT.PEM",
    "/p/credentials.json",
    "/p/secrets.yaml",
    "/p/secret",
    "/p/id_rsa",
    "/p/.git-credentials",
    "/home/u/.claude/.credentials.json",
  ]) {
    assert.equal(isDeniedPath(denied), true, `${denied} must be refused`);
  }
  for (const allowed of [
    "/p/src/keys.ts",
    "/p/keyboard.ts",
    "/p/env.ts",
    "/p/.environment",
    "/p/secretsmanager.ts",
    "/p/credentials-form.tsx",
    "/home/u/.config/nvim/init.lua",
    "/p/id_rsa.pub",
    "/p/README.md",
  ]) {
    assert.equal(isDeniedPath(allowed), false, `${allowed} must be allowed`);
  }
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "jev-files-"));
  const root = join(base, "root");
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "ok.txt"), "hello");
  writeFileSync(join(root, "nested", "deep.txt"), "deep");
  writeFileSync(join(base, "outside.txt"), "private");
  symlinkSync(join(base, "outside.txt"), join(root, "escape.txt"));
  writeFileSync(join(root, ".env"), "SECRET=1");
  writeFileSync(join(root, "binary.bin"), Buffer.from([0x61, 0x00, 0x62]));
  writeFileSync(join(root, "big.txt"), "x".repeat(101));
  writeFileSync(join(root, "wide.txt"), "😀".repeat(30)); // 120 bytes, 60 UTF-16 units
  return { base, root };
}

async function expectRefusal(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof FileAccessError, `expected FileAccessError, got ${error?.constructor?.name}: ${error?.message}`);
    assert.match(error.message, pattern);
    assert.ok(error.hint.length > 10, "a refusal must say what to do instead");
    return true;
  });
}

test("readTextFile reads regular files below a root, absolute or relative", async () => {
  const { root } = fixture();
  const options = { roots: [root], maxChars: 100 };
  assert.equal(await readTextFile(join(root, "ok.txt"), options), "hello");
  assert.equal(await readTextFile("ok.txt", options), "hello");
  assert.equal(await readTextFile("nested/deep.txt", options), "deep");
  assert.equal(await readTextFile("nested/../ok.txt", options), "hello");
});

test("readTextFile refuses escapes: traversal, symlinks, siblings, and the root itself", async () => {
  const { base, root } = fixture();
  const options = { roots: [root], maxChars: 100 };
  await expectRefusal(readTextFile("../outside.txt", options), /outside the allowed roots/);
  await expectRefusal(readTextFile(join(base, "outside.txt"), options), /outside the allowed roots/);
  await expectRefusal(readTextFile("escape.txt", options), /outside the allowed roots/);
  await expectRefusal(readTextFile(root, options), /outside the allowed roots/);
  // A missing file outside the roots gets the same answer as an existing one,
  // so the error is not an existence oracle.
  await expectRefusal(readTextFile(join(base, "nope.txt"), options), /outside the allowed roots/);
});

test("readTextFile refuses credential files, directories, binaries, and oversized content", async () => {
  const { root } = fixture();
  const options = { roots: [root], maxChars: 100 };
  await expectRefusal(readTextFile(".env", options), /credential/);
  await expectRefusal(readTextFile("nested", options), /Not a regular file/);
  await expectRefusal(readTextFile("binary.bin", options), /Binary/);
  await expectRefusal(readTextFile("big.txt", options), /above the 100 character limit/);
  await expectRefusal(readTextFile("missing.txt", options), /not found/);
});

test("regression: a FIFO is refused as not a regular file instead of blocking in open", async () => {
  const { root } = fixture();
  execFileSync("mkfifo", [join(root, "pipe")]);
  // A read-only open of a FIFO blocks until a writer appears. The reader must
  // classify the path before opening it, or this call never returns.
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("readTextFile hung on a FIFO")), 2000).unref());
  await expectRefusal(Promise.race([readTextFile("pipe", { roots: [root], maxChars: 100 }), timeout]), /Not a regular file/);
});

test("readTextFile measures characters, not bytes, so multibyte text is not over-refused", async () => {
  const { root } = fixture();
  const text = await readTextFile("wide.txt", { roots: [root], maxChars: 100 });
  assert.equal(text.length, 60);
});

test("readTextFile honours a caller-supplied refusal and disabled roots", async () => {
  const { root } = fixture();
  const keyFile = join(root, "ok.txt");
  await expectRefusal(readTextFile("ok.txt", { roots: [root], maxChars: 100, isDenied: (p) => p === keyFile }), /credential/);
  await expectRefusal(readTextFile("ok.txt", { roots: [], maxChars: 100 }), /disabled/);
});
