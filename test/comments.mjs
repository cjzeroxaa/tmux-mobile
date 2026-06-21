// Unit tests for pin comments (lib/comments.mjs + lib/comment-index.mjs).
// Covers: add/list/delete, visibility inherited from the pin (canSeePin),
// author-or-owner delete authz, and owner-only status updates. Uses in-memory
// pin + comment stores and a fake blob storage driver.

import assert from "node:assert/strict";

const { createPin, setPinIndex, hydratePins } = await import("../lib/pins.mjs");
const { createMemoryPinIndex } = await import("../lib/pin-index.mjs");
const { setCommentIndex } = await import("../lib/comments.mjs");
const comments = await import("../lib/comments.mjs");
const { createMemoryCommentStore } = await import("../lib/comment-index.mjs");

setPinIndex(createMemoryPinIndex());
await hydratePins();
setCommentIndex(createMemoryCommentStore());

function fakeStorage() {
  const objects = new Map();
  return {
    kind: "local",
    servesDirectly: () => false,
    async put(key, bytes) {
      if (!objects.has(key)) objects.set(key, Buffer.from(bytes));
      return { key, size: bytes.length };
    },
    async get(key) {
      const b = objects.get(key);
      return b ? { bytes: b, size: b.length } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async url() {
      return "";
    },
  };
}

const alice = { userId: "alice@x.com", email: "alice@x.com", hd: "x.com" };
const bob = { userId: "bob@x.com", email: "bob@x.com", hd: "x.com" };
const carol = { userId: "carol@y.com", email: "carol@y.com", hd: "y.com" };

let clock = 1000;
const now = () => clock++;

try {
  const storage = fakeStorage();
  const { pin } = await createPin(
    {
      viewer: alice,
      bytes: Buffer.from("# doc v1"),
      name: "doc.md",
      ext: ".md",
      kind: "markdown",
      contentType: "text/markdown",
      sourcePath: "/proj/doc.md",
      sourceMachineId: "mini",
      share: { scope: "private" },
    },
    { storage, now },
  );
  const token = pin.token;

  // Owner can add + list.
  const c1 = await comments.addComment(alice, token, { aid: "blk1", text: "first note" }, { now });
  assert.equal(c1.text, "first note");
  assert.equal(c1.aid, "blk1");
  assert.equal(c1.owned, true);
  let list = await comments.listComments(alice, token);
  assert.equal(list.length, 1, "owner sees the comment");

  // Private pin: a different user can neither read nor add.
  await assert.rejects(() => comments.listComments(bob, token), (e) => e.status === 403);
  await assert.rejects(
    () => comments.addComment(bob, token, { aid: "blk1", text: "nope" }, { now }),
    (e) => e.status === 403,
  );

  // Empty text rejected.
  await assert.rejects(
    () => comments.addComment(alice, token, { aid: "blk1", text: "   " }, { now }),
    (e) => e.status === 400,
  );

  // Re-scope to org → same-domain bob can read + add; other-domain carol cannot.
  const { updateShare } = await import("../lib/pins.mjs");
  await updateShare(pin.id, alice, { scope: "org" }, { now });
  const c2 = await comments.addComment(bob, token, { aid: "blk2", text: "bob's note" }, { now });
  assert.equal(c2.owned, true, "bob owns his own comment");
  list = await comments.listComments(bob, token);
  assert.equal(list.length, 2, "org viewer sees all comments");
  assert.ok(
    list.find((c) => c.id === c1.id && c.owned === false),
    "bob does not own alice's comment",
  );
  await assert.rejects(() => comments.listComments(carol, token), (e) => e.status === 403);

  // Delete authz: bob cannot delete alice's comment; alice (author) can.
  await assert.rejects(
    () => comments.deleteComment(bob, token, c1.id),
    (e) => e.status === 403,
    "non-author non-owner cannot delete",
  );
  await comments.deleteComment(alice, token, c1.id);
  list = await comments.listComments(alice, token);
  assert.equal(list.length, 1, "alice deleted her comment");

  // Pin owner can delete anyone's comment on their pin (bob's note).
  await comments.deleteComment(alice, token, c2.id);
  list = await comments.listComments(alice, token);
  assert.equal(list.length, 0, "owner deleted bob's comment");

  // Status: owner-only. Add one, bob can't set status, alice can.
  const c3 = await comments.addComment(bob, token, { aid: "blk3", text: "please fix" }, { now });
  await assert.rejects(
    () => comments.setCommentStatus(bob, token, c3.id, "applied", { now }),
    (e) => e.status === 403,
    "non-owner cannot set status",
  );
  const updated = await comments.setCommentStatus(alice, token, c3.id, "applied", { now });
  assert.equal(updated.status, "applied");
  await assert.rejects(
    () => comments.setCommentStatus(alice, token, c3.id, "bogus", { now }),
    (e) => e.status === 400,
  );

  console.log("comments unit tests passed");
} catch (error) {
  console.error("comments tests FAILED:", error);
  process.exitCode = 1;
}
