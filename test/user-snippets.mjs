import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "tmux-mobile-snippets-"));

const {
  DEFAULT_SNIPPETS,
  createFileSnippetStore,
  createMemorySnippetStore,
  createSnippetStore,
  describeUserSnippets,
  resetUserSnippets,
  sanitizeSnippetItems,
  updateUserSnippets,
} = await import("../lib/user-snippets.mjs");

try {
  assert.deepEqual(
    sanitizeSnippetItems([{ text: "/btw " }]),
    [{ text: "/btw " }],
    "trailing spaces are preserved when meaningful",
  );

  assert.equal(
    (await createSnippetStore({ TMUX_MOBILE_SNIPPETS_STORE: "memory" })).kind,
    "memory",
  );
  assert.equal(
    (await createSnippetStore({
      TMUX_MOBILE_SNIPPETS_STORE: "file",
      TMUX_MOBILE_SNIPPETS_CONFIG: path.join(dir, "factory.json"),
    })).kind,
    "file",
  );
  await assert.rejects(
    () => createSnippetStore({ TMUX_MOBILE_SNIPPETS_STORE: "wat" }),
    /Unknown TMUX_MOBILE_SNIPPETS_STORE/,
  );

  const memory = createMemorySnippetStore();
  assert.deepEqual(
    (await describeUserSnippets(memory, "alice")).items,
    DEFAULT_SNIPPETS.map((item) => ({ ...item })),
    "new user sees defaults",
  );
  assert.equal((await describeUserSnippets(memory, "alice")).customized, false);

  await updateUserSnippets(memory, "alice", [{ text: "ship it" }, { text: "/btw " }], {
    now: () => 123,
  });
  assert.deepEqual((await describeUserSnippets(memory, "alice")).items, [
    { text: "ship it" },
    { text: "/btw " },
  ]);
  assert.equal((await describeUserSnippets(memory, "alice")).updatedAt, 123);
  assert.equal(
    (await describeUserSnippets(memory, "bob")).items[0].text,
    "yes",
    "alice snippets do not leak to bob",
  );

  await updateUserSnippets(memory, "alice", []);
  const empty = await describeUserSnippets(memory, "alice");
  assert.equal(empty.customized, true, "empty list is a real user preference");
  assert.deepEqual(empty.items, []);

  await resetUserSnippets(memory, "alice");
  assert.equal((await describeUserSnippets(memory, "alice")).customized, false);

  await assert.rejects(() => updateUserSnippets(memory, "alice", null), (error) => {
    assert.equal(error.status, 400);
    return true;
  });

  const cfg = path.join(dir, "snippets.json");
  const a = createFileSnippetStore({ TMUX_MOBILE_SNIPPETS_CONFIG: cfg });
  await updateUserSnippets(a, "alice@example.com", [{ text: "from disk" }]);
  const b = createFileSnippetStore({ TMUX_MOBILE_SNIPPETS_CONFIG: cfg });
  await b.load();
  assert.deepEqual((await describeUserSnippets(b, "alice@example.com")).items, [
    { text: "from disk" },
  ]);

  console.log("user-snippets unit tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
