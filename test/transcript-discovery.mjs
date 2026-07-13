import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  agentSessionIdFromFilename,
  discoverTranscriptFiles,
} from "../lib/transcript-discovery.mjs";

const dir = await mkdtemp(path.join(os.tmpdir(), "tmux-mobile-transcript-discovery-"));
const codexRoot = path.join(dir, "codex-sessions");
const claudeRoot = path.join(dir, "claude-projects");
const outsideRoot = path.join(dir, "outside");

const codexSessionId = "01965417-81b4-7362-b259-7ce5dfbc385b";
const claudeSessionId = "9ce973f6-274d-4df8-b3ec-6f1100c52af7";
const escapedSessionId = "1da8295e-bb70-4433-8ccb-984474e912ab";

try {
  const codexDirectory = path.join(codexRoot, "2026", "07", "12");
  const claudeDirectory = path.join(claudeRoot, "-Users-test-project");
  await Promise.all([
    mkdir(codexDirectory, { recursive: true }),
    mkdir(claudeDirectory, { recursive: true }),
    mkdir(outsideRoot, { recursive: true }),
  ]);

  const codexPath = path.join(
    codexDirectory,
    `rollout-2026-07-12T08-30-14-${codexSessionId}.jsonl`,
  );
  const claudePath = path.join(claudeDirectory, `${claudeSessionId}.jsonl`);
  await Promise.all([
    writeFile(codexPath, "not parsed by discovery\n"),
    writeFile(claudePath, "also not parsed\n"),
  ]);

  // Valid UUIDs do not make non-JSONL files or directories transcripts.
  await writeFile(path.join(codexDirectory, `${escapedSessionId}.txt`), "ignored\n");
  await mkdir(path.join(codexDirectory, `${escapedSessionId}.jsonl`));
  await writeFile(path.join(claudeDirectory, "missing-session-id.jsonl"), "ignored\n");

  // Neither a file symlink nor a directory symlink may escape an allowlisted
  // root, even when the destination has an otherwise valid transcript name.
  const outsideTranscript = path.join(outsideRoot, `${escapedSessionId}.jsonl`);
  await writeFile(outsideTranscript, "outside\n");
  await symlink(
    outsideTranscript,
    path.join(codexDirectory, `rollout-${escapedSessionId}.jsonl`),
  );
  await symlink(outsideRoot, path.join(claudeRoot, "escaped-project"));

  const discovered = await discoverTranscriptFiles({
    roots: [
      { kind: "codex", root: codexRoot },
      { kind: "claude", root: claudeRoot },
    ],
  });
  const [resolvedCodexPath, resolvedClaudePath] = await Promise.all([
    realpath(codexPath),
    realpath(claudePath),
  ]);

  assert.deepEqual(discovered, [
    {
      kind: "codex",
      agentSessionId: codexSessionId,
      transcriptPath: resolvedCodexPath,
    },
    {
      kind: "claude",
      agentSessionId: claudeSessionId,
      transcriptPath: resolvedClaudePath,
    },
  ]);

  const earlierId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  assert.equal(
    agentSessionIdFromFilename(`rollout-${earlierId}-${codexSessionId}.jsonl`),
    codexSessionId,
    "the final UUID in a rollout filename is the agent session id",
  );

  assert.deepEqual(
    await discoverTranscriptFiles({
      roots: [{ kind: "codex", root: path.join(dir, "does-not-exist") }],
    }),
    [],
    "an absent optional transcript root is empty",
  );

  console.log("transcript discovery tests passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
