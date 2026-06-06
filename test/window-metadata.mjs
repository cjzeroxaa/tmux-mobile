// Unit tests for the per-window metadata layer: agent-type detection, the
// git-remote parser, and the cwd-keyed TTL cache / dedup behavior.

import assert from "node:assert/strict";
import { parseGitRemote } from "../lib/backend.mjs";
import {
  detectAgentType,
  detectAgentFromCommandLine,
  isInterpreter,
  computeWindowMetadata,
  createMetadataCache,
} from "../lib/window-metadata.mjs";

// --- git remote parsing ---
assert.deepEqual(parseGitRemote("https://github.com/acme/widget.git"), {
  host: "github.com",
  owner: "acme",
  name: "widget",
});
assert.deepEqual(parseGitRemote("git@github.com:acme/widget.git"), {
  host: "github.com",
  owner: "acme",
  name: "widget",
});
assert.deepEqual(parseGitRemote("ssh://git@github.com/o/r.git"), {
  host: "github.com",
  owner: "o",
  name: "r",
});
assert.deepEqual(parseGitRemote("https://github.com/o/r"), { host: "github.com", owner: "o", name: "r" });
assert.deepEqual(parseGitRemote(""), { host: "", owner: "", name: "" });
assert.deepEqual(parseGitRemote("garbage"), { host: "", owner: "", name: "" });

// --- agent detection ---
assert.equal(detectAgentType("claude"), "claude");
assert.equal(detectAgentType("codex"), "codex");
assert.equal(detectAgentType("gemini"), "gemini");
assert.equal(detectAgentType("CLAUDE"), "claude"); // normalized
assert.equal(detectAgentType("node"), null);
assert.equal(detectAgentType(""), null);

// --- interpreter-launched agents (node /usr/bin/codex etc.) ---
assert.ok(isInterpreter("node") && isInterpreter("python3") && !isInterpreter("codex"));
assert.equal(detectAgentFromCommandLine("node /usr/bin/codex --yolo"), "codex");
assert.equal(detectAgentFromCommandLine("node /usr/lib/node_modules/@openai/codex/bin/codex.js"), "codex");
assert.equal(detectAgentFromCommandLine("node /usr/bin/claude"), "claude");
assert.equal(detectAgentFromCommandLine("/usr/bin/gemini chat"), "gemini");
assert.equal(detectAgentFromCommandLine("node server.mjs --foo"), null);
assert.equal(detectAgentFromCommandLine("vim --codex-notes"), null); // flag, not a basename

// computeWindowMetadata uses backend.paneCommand to resolve interpreter windows,
// only for interpreter foreground commands, cached per tty.
let psCalls = 0;
const ttyBackend = {
  async paneCommand(tty) {
    psCalls += 1;
    return { command: tty === "/dev/pts/1" ? "node /usr/bin/codex --yolo" : "node app.js" };
  },
  async repo() { return { host: "", owner: "", name: "" }; },
  async branch() { return { branch: "", worktree: false }; },
};
const ttyCache = createMetadataCache();
const ttyWins = [
  { id: "@a", cwd: "/x", activeCommand: "node", tty: "/dev/pts/1" },   // -> codex via ps
  { id: "@b", cwd: "/x", activeCommand: "node", tty: "/dev/pts/2" },   // -> null
  { id: "@c", cwd: "/x", activeCommand: "claude", tty: "/dev/pts/3" }, // -> claude, no ps
];
let tmd = await computeWindowMetadata(ttyWins, ttyBackend, ttyCache, 1000);
assert.equal(tmd["@a"].agentType, "codex", "node /usr/bin/codex -> codex");
assert.equal(tmd["@b"].agentType, null, "plain node -> null");
assert.equal(tmd["@c"].agentType, "claude", "direct claude, no ps");
assert.equal(psCalls, 2, `ps only for interpreter windows: ${psCalls}`);
tmd = await computeWindowMetadata(ttyWins, ttyBackend, ttyCache, 5000);
assert.equal(psCalls, 2, "paneCommand cached per tty within TTL");

// --- computeWindowMetadata: live + cwd-scoped, cache + dedup + TTL ---
let repoCalls = 0;
const backend = {
  async repo(cwd) {
    repoCalls += 1;
    return cwd === "/repo"
      ? { host: "github.com", owner: "o", name: "r" }
      : { host: "", owner: "", name: "" };
  },
  async branch() {
    return { branch: "main", worktree: false };
  },
};
const cache = createMetadataCache();
const wins = [
  { id: "@1", cwd: "/repo", activeCommand: "claude" },
  { id: "@2", cwd: "/repo", activeCommand: "node" }, // shares cwd with @1
  { id: "@3", cwd: "/x", activeCommand: "codex" },
  { id: "@4", cwd: "", activeCommand: "gemini" }, // no cwd
];

let md = await computeWindowMetadata(wins, backend, cache, 1000);
assert.equal(md["@1"].agentType, "claude");
assert.equal(md["@2"].agentType, null);
assert.equal(md["@3"].agentType, "codex");
assert.equal(md["@4"].agentType, "gemini");
assert.deepEqual(md["@1"].repo, { host: "github.com", owner: "o", name: "r" });
assert.equal(md["@2"].repo.owner, "o", "shared cwd reuses repo");
assert.equal(md["@3"].repo, null, "non-repo cwd -> null repo");
assert.equal(md["@4"].repo, null, "no cwd -> null repo");
assert.equal(repoCalls, 2, `2 unique cwds resolved (not 3-4): ${repoCalls}`);

// within TTL: cache hit, no new resolver calls
md = await computeWindowMetadata(wins, backend, cache, 5000);
assert.equal(repoCalls, 2, "cache hit within TTL");

// after the repo TTL (10 min): re-resolve
md = await computeWindowMetadata(wins, backend, cache, 1000 + 10 * 60 * 1000 + 1);
assert.ok(repoCalls > 2, "re-resolved after TTL");

// a throwing resolver yields null metadata, never an exception
const badBackend = { async repo() { throw new Error("boom"); }, async branch() { throw new Error("boom"); } };
const md2 = await computeWindowMetadata([{ id: "@x", cwd: "/p", activeCommand: "claude" }], badBackend, createMetadataCache(), 1);
assert.equal(md2["@x"].repo, null, "resolver error -> null");
assert.equal(md2["@x"].agentType, "claude", "live field still computed");

console.log("window-metadata unit tests passed");
