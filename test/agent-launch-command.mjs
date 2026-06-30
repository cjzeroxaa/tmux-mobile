import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildAgentLaunchCommand } from "../lib/agent-launch-command.mjs";

const execFileAsync = promisify(execFile);

const CODEX_FLAGS = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
];
const CLAUDE_FLAGS = ["--dangerously-skip-permissions"];

async function makeTempBin(name, script) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tm-agent-launch-"));
  const file = path.join(dir, name);
  await writeFile(file, script, "utf8");
  await chmod(file, 0o755);
  return {
    dir,
    async run(command, env = {}) {
      const result = await execFileAsync("/bin/sh", ["-c", command], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH || ""}`, ...env },
        maxBuffer: 1024 * 1024,
      });
      return result.stdout.trim().split("\n").filter(Boolean);
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function stripPrefixes(lines) {
  return lines.map((line) => line.replace(/^(arg|default):/, ""));
}

function count(values, needle) {
  return values.filter((value) => value === needle).length;
}

const codexScript = `#!/bin/sh
has_help=0
has_bypass=0
has_hook=0
for arg in "$@"; do
  case "$arg" in
    --help) has_help=1 ;;
    --dangerously-bypass-approvals-and-sandbox) has_bypass=1 ;;
    --dangerously-bypass-hook-trust) has_hook=1 ;;
  esac
done
if [ "$CODEX_DEFAULT_BYPASS" = "1" ] && [ "$has_bypass" = "1" ]; then
  echo "error: the argument '--dangerously-bypass-approvals-and-sandbox' cannot be used multiple times" >&2
  exit 2
fi
if [ "$CODEX_DEFAULT_HOOK" = "1" ] && [ "$has_hook" = "1" ]; then
  echo "error: the argument '--dangerously-bypass-hook-trust' cannot be used multiple times" >&2
  exit 2
fi
if [ "$has_help" = "1" ]; then
  exit 0
fi
if [ "$CODEX_DEFAULT_BYPASS" = "1" ]; then echo "default:--dangerously-bypass-approvals-and-sandbox"; fi
if [ "$CODEX_DEFAULT_HOOK" = "1" ]; then echo "default:--dangerously-bypass-hook-trust"; fi
for arg in "$@"; do echo "arg:$arg"; done
`;

const claudeScript = `#!/bin/sh
has_help=0
has_skip=0
for arg in "$@"; do
  case "$arg" in
    --help) has_help=1 ;;
    --dangerously-skip-permissions) has_skip=1 ;;
  esac
done
if [ "$CLAUDE_DEFAULT_SKIP" = "1" ] && [ "$has_skip" = "1" ]; then
  echo "error: the argument '--dangerously-skip-permissions' cannot be used multiple times" >&2
  exit 2
fi
if [ "$has_help" = "1" ]; then
  exit 0
fi
if [ "$CLAUDE_DEFAULT_SKIP" = "1" ]; then echo "default:--dangerously-skip-permissions"; fi
echo "env:$CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN"
for arg in "$@"; do echo "arg:$arg"; done
`;

{
  const bin = await makeTempBin("codex", codexScript);
  try {
    const command = buildAgentLaunchCommand({
      executable: "codex",
      requiredFlags: CODEX_FLAGS,
    });
    assert.deepEqual(stripPrefixes(await bin.run(command)), CODEX_FLAGS);
  } finally {
    await bin.cleanup();
  }
}

{
  const bin = await makeTempBin("codex", codexScript);
  try {
    const command = buildAgentLaunchCommand({
      executable: "codex",
      requiredFlags: CODEX_FLAGS,
    });
    const flags = stripPrefixes(await bin.run(command, { CODEX_DEFAULT_BYPASS: "1" }));
    assert.equal(count(flags, CODEX_FLAGS[0]), 1, "wrapper-provided bypass flag is not duplicated");
    assert.equal(count(flags, CODEX_FLAGS[1]), 1, "missing hook-trust flag is still added");
  } finally {
    await bin.cleanup();
  }
}

{
  const bin = await makeTempBin("codex", codexScript);
  try {
    const command = buildAgentLaunchCommand({
      executable: "codex",
      args: ["fork", "--last"],
      requiredFlags: CODEX_FLAGS,
    });
    const values = stripPrefixes(
      await bin.run(command, { CODEX_DEFAULT_BYPASS: "1", CODEX_DEFAULT_HOOK: "1" }),
    );
    assert.equal(count(values, CODEX_FLAGS[0]), 1, "default bypass flag remains once");
    assert.equal(count(values, CODEX_FLAGS[1]), 1, "default hook-trust flag remains once");
    assert.ok(values.includes("fork"), "fork subcommand is preserved");
    assert.ok(values.includes("--last"), "fork flag is preserved");
  } finally {
    await bin.cleanup();
  }
}

{
  const bin = await makeTempBin("claude", claudeScript);
  try {
    const command = buildAgentLaunchCommand({
      executable: "claude",
      args: ["--continue", "--fork-session"],
      requiredFlags: CLAUDE_FLAGS,
      env: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1" },
    });
    const values = stripPrefixes(await bin.run(command, { CLAUDE_DEFAULT_SKIP: "1" }));
    assert.ok(values.includes("env:1"), "launch env is preserved");
    assert.equal(count(values, CLAUDE_FLAGS[0]), 1, "wrapper-provided Claude flag is not duplicated");
    assert.ok(values.includes("--continue"), "Claude fork arg is preserved");
    assert.ok(values.includes("--fork-session"), "Claude fork arg is preserved");
  } finally {
    await bin.cleanup();
  }
}
