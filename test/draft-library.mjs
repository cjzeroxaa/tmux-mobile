import assert from "node:assert/strict";
import { draftLibrary, draftLibraryUrl } from "../public/draft-library.mjs";
import { createDrafts } from "../lib/drafts.mjs";
import { memoryDraftStore } from "../lib/draft-store.mjs";

const records = [
  { id: "a", machineId: "one", kind: "codex", sessionId: "s1", updatedAt: 1 },
  { id: "b", machineId: "two", kind: "claude", sessionId: "s2", updatedAt: 3 },
  { id: "c", machineId: "one", kind: "pi", sessionId: "s3", updatedAt: 2 },
  { id: "private", machineId: "private-machine", kind: "codex", sessionId: "s4", updatedAt: 4 },
];
const store = memoryDraftStore();
for (const record of records) await store.put({ family: "tmax-drafts", ...record });
let machines = [{ id: "one", hostname: "Beta" }, { id: "two", hostname: "Alpha" }, { id: "private-machine", hostname: "Secret" }];
const makeDrafts = () => createDrafts({ store, storage: {}, canAccess: (_, id) => id !== "private-machine", listMachines: () => machines });
const drafts = makeDrafts();
const all = await drafts.list({});
assert.deepEqual(all.map(d => d.id), ["b", "c", "a"]);
assert.deepEqual((await drafts.list({}, { machineId: "one", kind: "codex", sessionId: "s1" })).map(d => d.id), ["a"]);
assert.equal((await store.list("tmax-draft-machines")).length, 2, "do not store another viewer's machine metadata");
machines = [];
assert.deepEqual(await makeDrafts().list({}), all, "offline machines and their names survive controller restart");
const library = draftLibrary(all);
assert.deepEqual(library.machines.map(m => [m.name, m.count]), [["Alpha", 1], ["Beta", 2]]);
assert.deepEqual(library.groups[0].drafts.map(d => d.id), ["b", "c", "a"]);
assert.deepEqual(draftLibrary(all, { sort: "machine" }).groups.map(g => [g.name, g.drafts.map(d => d.id)]), [["Alpha", ["b"]], ["Beta", ["c", "a"]]]);
assert.equal(draftLibrary(all, { machineId: "one", kind: "codex", sessionId: "s1" }).count, 1);
assert.equal(draftLibrary(all, { machineId: "one" }).machines.length, 2, "machine choices stay available inside a filtered session");
assert.equal(draftLibrary(all, { machineId: "missing" }).count, 0);
assert.equal(draftLibraryUrl({ embedded: true }), "/drafts?embedded=1", "All drafts clears machine, session and selected-document filters while staying in the app");
const url = new URL(draftLibraryUrl({ embedded: true, machineId: "m:a:b", kind: "codex", sessionId: "session", sort: "machine", id: "draft" }), "https://example.com");
assert.equal(url.searchParams.get("machineId"), "m:a:b");
assert.equal(url.searchParams.get("sort"), "machine");
console.log("draft library: cross-machine access, offline history, descending sort and navigation passed");
