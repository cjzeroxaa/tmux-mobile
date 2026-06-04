// Unit test for localBackend.writeTempFile (the file-upload backend op): writes
// an uploaded file to a temp dir, sanitizes the name, avoids clobbering, and
// returns the absolute path. Uses TMUX_MOBILE_UPLOAD_DIR to keep it isolated.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(os.tmpdir(), "tmux-mobile-wf-test-"));
process.env.TMUX_MOBILE_UPLOAD_DIR = dir;

// Import AFTER setting the env (backend reads it at call time, so order is not
// strictly required, but keeps intent clear).
const { localBackend } = await import("../lib/backend.mjs");

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// 1. Basic write returns a path inside the upload dir, with correct bytes.
let res = await localBackend.writeTempFile("hello.txt", b64("hello world"));
assert.equal(path.dirname(res.path), dir, "1 written into upload dir");
assert.equal(res.name, "hello.txt", "1 keeps a clean name");
assert.equal(await readFile(res.path, "utf8"), "hello world", "1 bytes round-trip");

// 2. Path-traversal / directory components are stripped to a basename.
res = await localBackend.writeTempFile("../../etc/passwd", b64("x"));
assert.equal(path.dirname(res.path), dir, "2 stays in upload dir");
assert.ok(!res.name.includes("/") && !res.name.includes(".."), `2 safe name: ${res.name}`);

// 3. Collision doesn't clobber — second "dup.txt" becomes dup-1.txt etc.
const a = await localBackend.writeTempFile("dup.txt", b64("first"));
const c = await localBackend.writeTempFile("dup.txt", b64("second"));
assert.notEqual(a.path, c.path, "3 second write got a distinct path");
assert.equal(await readFile(a.path, "utf8"), "first", "3 first file untouched");
assert.equal(await readFile(c.path, "utf8"), "second", "3 second file has its own bytes");

// 4. Empty/odd names fall back to "upload".
res = await localBackend.writeTempFile("", b64("y"));
assert.ok(res.name.startsWith("upload"), `4 fallback name: ${res.name}`);

// 5. Binary content (non-utf8) round-trips byte-exact.
const bin = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
res = await localBackend.writeTempFile("blob.bin", bin.toString("base64"));
assert.deepEqual(await readFile(res.path), bin, "5 binary bytes exact");

await rm(dir, { recursive: true, force: true });
console.log("writefile unit tests passed");
