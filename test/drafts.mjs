import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDraftStore, memoryDraftStore } from "../lib/draft-store.mjs";
import {
  createDrafts,
  validateDraftHtml,
  draftRelativePath,
  draftGenerationPrompt,
  draftFeedbackPrompt,
} from "../lib/drafts.mjs";
import { locateDraftQuote } from "../public/draft-anchors.mjs";
import { handleDraftHttp } from "../lib/draft-http.mjs";
const owner = { userId: "owner@example.com" },
  stranger = { userId: "stranger@example.com" };
const store = memoryDraftStore(),
  blobs = new Map();
let puts = 0,
  gets = 0;
const storage = {
  async put(k, b) {
    puts++;
    blobs.set(k, Buffer.from(b));
  },
  async get(k) {
    gets++;
    return { bytes: blobs.get(k) };
  },
};
const drafts = createDrafts({
  store,
  storage,
  canAccess: (v, m) => v.userId === owner.userId && m === "machine-1",
});
const html = (text) =>
  Buffer.from(
    `<!doctype html><html><head><title>Review</title><style>p{color:green}</style></head><body><h1>PR review</h1><p>${text}</p><script>document.body.dataset.interactive='yes';</script></body></html>`,
  );
const metadata = {
  kind: "codex",
  sessionId: "session-1",
  filename: "review.html",
  expectedVersion: 0,
};
const publish = (text, expectedVersion = 0) =>
  drafts.publish({
    ownerId: owner.userId,
    machineId: "machine-1",
    metadata: { ...metadata, expectedVersion },
    bytes: html(text),
  });
const first = await publish("A selected sentence.");
assert.equal(first.version, 1);
const retry = await publish("A selected sentence.");
assert.equal(retry.version, 1);
assert.equal(puts, 1);
assert.equal(gets, 0, "no history reads from S3 on retry");
await assert.rejects(
  () => publish("Stale overwrite"),
  (e) => e.status === 409,
);
assert.equal(puts, 1);
const comment = await drafts.comment(owner, first.id, {
  version: 1,
  text: "Explain the evidence",
  anchor: { quote: "selected sentence", prefix: "A ", suffix: "." },
});
assert.equal(comment.version, 1);
assert.equal(comment.scope, "selection");
const overall = await drafts.comment(owner, first.id, {
  version: 1,
  text: "  Make the whole explanation shorter  ",
});
assert.equal(overall.scope, "document");
assert.equal(overall.anchor, null);
assert.equal(overall.text, "Make the whole explanation shorter");
for (const invalid of [
  { text: " " },
  { text: "x".repeat(4001) },
  { text: "feedback", anchor: {} },
  { text: "feedback", anchor: { quote: " " } },
  { text: "feedback", anchor: { quote: "x".repeat(12001) } },
]) {
  await assert.rejects(
    () => drafts.comment(owner, first.id, { version: 1, ...invalid }),
    (e) => e.status === 400,
  );
}
await assert.rejects(
  () => drafts.comment(stranger, first.id, { version: 1, text: "Overall" }),
  (e) => e.status === 404,
);
const writes = await Promise.allSettled([
  publish("New version A", 1),
  publish("New version B", 1),
]);
assert.equal(writes.filter((x) => x.status === "fulfilled").length, 1);
assert.equal(
  writes.filter((x) => x.status === "rejected")[0].reason.status,
  409,
);
const detail = await drafts.detail(owner, first.id);
assert.equal(detail.draft.version, 2);
assert.equal(detail.versions.length, 2);
assert.equal(detail.comments.length, 2);
assert.equal(detail.comments[0].anchor.quote, "selected sentence");
assert.equal(detail.comments.find((c) => c.id === overall.id).version, 1);
await drafts.resolve(owner, first.id, overall.id, "resolved");
assert.equal((await drafts.detail(owner, first.id)).comments.find((c) => c.id === overall.id).status, "resolved");
await drafts.resolve(owner, first.id, overall.id, "open");
assert.match(
  (await drafts.read(owner, first.id, 1)).html,
  /A selected sentence/,
);
await assert.rejects(
  () => drafts.detail(stranger, first.id),
  (e) => e.status === 404,
);
assert.equal((await drafts.list(stranger)).length, 0);
await assert.rejects(
  () =>
    drafts.comment(stranger, first.id, {
      version: 1,
      text: "no",
      anchor: { quote: "q" },
    }),
  (e) => e.status === 404,
);
await assert.rejects(
  () =>
    drafts.comment(owner, first.id, {
      version: 99,
      text: "no",
      anchor: { quote: "q" },
    }),
  (e) => e.status === 400,
);
await drafts.resolve(owner, first.id, comment.id, "resolved");
assert.equal(
  (await drafts.detail(owner, first.id)).comments[0].status,
  "resolved",
);
assert.throws(() => draftRelativePath(metadata, "../escape.html"));
assert.throws(() =>
  validateDraftHtml(html('<script src="https://example.com/a.js"></script>')),
);
assert.throws(() => validateDraftHtml(Buffer.from("<html><body>unfinished")));
assert.doesNotThrow(() =>
  validateDraftHtml(html('<img src="data:image/png;base64,abc">')),
);
assert.match(
  draftGenerationPrompt(metadata, "review.html", "Explain PR"),
  /PR Lens/,
);
assert.match(draftFeedbackPrompt(detail.draft, [comment]), /Version 1/);
const mixedFeedback = draftFeedbackPrompt(detail.draft, [comment, overall]);
assert.match(mixedFeedback, /Selected text: "selected sentence"/);
assert.match(mixedFeedback, /Overall comment \(whole draft\)/);
assert.match(mixedFeedback, /Make the whole explanation shorter/);
assert.equal(
  locateDraftQuote("first same second same", { quote: "same" }).status,
  "ambiguous",
);
assert.deepEqual(
  locateDraftQuote("first same second same", {
    quote: "same",
    prefix: "second ",
  }),
  { status: "found", start: 18, end: 22 },
);
assert.equal(locateDraftQuote("changed", { quote: "old" }).status, "missing");
assert.equal(
  locateDraftQuote("moved exact quote", {
    quote: "exact quote",
    prefix: "outdated",
  }).status,
  "found",
);
const headers = {};
let status, body;
const res = {
  setHeader(k, v) {
    headers[k] = v;
  },
  writeHead(s, h) {
    status = s;
    Object.assign(headers, h);
  },
  end(b) {
    body = b;
  },
};
await handleDraftHttp(
  { method: "GET" },
  res,
  new URL(`http://test/api/drafts/content?id=${first.id}&version=1`),
  {
    drafts,
    viewer: owner,
    sendJson: (r, s, b) => {
      status = s;
      body = b;
    },
  },
);
assert.equal(status, 200);
assert.match(headers["content-security-policy"], /sandbox allow-scripts/);
assert.doesNotMatch(headers["content-security-policy"], /allow-same-origin/);
assert.match(body, /locateDraftQuote/);
assert.match(body, /tmax-draft/);
const temp = await mkdtemp(path.join(os.tmpdir(), "draft-store-test-"));
try {
  const env = { TMUX_MOBILE_DRAFTS_CONFIG: path.join(temp, "drafts.json") };
  const a = await createDraftStore(env);
  await a.commit(
    { family: "heads", id: "a", version: 1 },
    { family: "a", id: "v1" },
    0,
  );
  const b = await createDraftStore(env);
  assert.equal((await b.get("heads", "a")).version, 1);
  await assert.rejects(() =>
    b.commit(
      { family: "heads", id: "a", version: 2 },
      { family: "a", id: "v2" },
      0,
    ),
  );
  assert.equal((await b.list("a")).length, 1);
} finally {
  await rm(temp, { recursive: true, force: true });
}
console.log(
  "drafts: versions, concurrent updates, idempotency, permissions, anchors, sandbox and persistence passed",
);
