import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function writeExecutable(filePath, source) {
  await writeFile(filePath, source, "utf8");
  await chmod(filePath, 0o755);
}

const recordPrelude = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(
  process.env.FAKE_INVENTORY_CALL_LOG,
  JSON.stringify({ command: process.argv[1].split("/").at(-1), args }) + "\\n",
);
`;

async function makeFakeCommands(dir) {
  const binDir = path.join(dir, "bin");
  await mkdir(binDir, { recursive: true });

  await writeExecutable(
    path.join(binDir, "ps"),
    `${recordPrelude}
process.stdout.write([
  "100 1 codex",
  "200 1 codex",
].join("\\n") + "\\n");
`,
  );

  await writeExecutable(
    path.join(binDir, "lsof"),
    `${recordPrelude}
process.stdout.write("p100\\np200\\n");
`,
  );

  await writeExecutable(
    path.join(binDir, "tmux"),
    `${recordPrelude}
const mode = process.env.FAKE_INVENTORY_MODE || "fast";
const tmuxArgs = args[0] === "-u" ? args.slice(1) : args;
const command = tmuxArgs[0] || "";
const has = (value) => tmuxArgs.includes(value);
const windows = [
  "@1\\t0\\tcodex-one\\t1\\t1\\t*\\tcodex\\t/dev/ttys001\\t/repo-one\\t",
  "@2\\t1\\tcodex-two\\t0\\t1\\t-\\tcodex\\t/dev/ttys002\\t/repo-two\\t",
];
const panes = [
  "%1\\t0\\t1\\tcodex\\t/repo-one\\t100\\t32\\t\\t100\\tCodex one",
  "%2\\t0\\t1\\tcodex\\t/repo-two\\t100\\t32\\t\\t200\\tCodex two",
];

if (tmuxArgs[0] === "-V") {
  process.stdout.write("tmux 3.5\\n");
} else if (command === "list-windows" && has("-a")) {
  if (mode === "tree-fallback") {
    process.stderr.write("unknown option -- a\\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(
      windows
        .map((window) => "$1\\twork\\t2\\t1\\tcreated\\t" + window)
        .join("\\n") + "\\n",
    );
  }
} else if (command === "list-sessions") {
  process.stdout.write("$1\\twork\\t2\\t1\\tcreated\\n");
} else if (command === "list-windows") {
  process.stdout.write(windows.join("\\n") + "\\n");
} else if (command === "list-panes" && has("-a")) {
  if (mode === "surfaces-fallback") {
    process.stderr.write("unknown option -- a\\n");
    process.exitCode = 1;
  } else {
    const visible = mode === "missing-surface" ? panes.slice(0, 1) : panes;
    process.stdout.write(
      visible
        .map((pane, index) => "@" + (index + 1) + "\\t" + pane)
        .join("\\n") + "\\n",
    );
  }
} else if (command === "list-panes") {
  const target = tmuxArgs[tmuxArgs.indexOf("-t") + 1];
  process.stdout.write((target === "@2" ? panes[1] : panes[0]) + "\\n");
} else if (command === "capture-pane") {
  process.stdout.write(
    "ready\\n  gpt-5.6-terra high · Context 90% left · /repo · gpt-5.6-terra\\n",
  );
} else {
  process.stderr.write("unexpected fake tmux call: " + tmuxArgs.join(" ") + "\\n");
  process.exitCode = 2;
}
`,
  );

  return binDir;
}

async function waitForHealth(baseUrl, child) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`fixture server exited early (${child.exitCode})`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fixture server did not become healthy: ${lastError?.message}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("fixture server did not stop")), 5_000),
    ),
  ]);
}

async function readCalls(filePath) {
  try {
    return (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function matching(calls, command, predicate = () => true) {
  return calls.filter(
    (call) =>
      call.command === command &&
      predicate(
        command === "tmux" && call.args[0] === "-u"
          ? call.args.slice(1)
          : call.args,
      ),
  );
}

async function runInventory(mode) {
  const fixtureDir = await mkdtemp(
    path.join(tmpdir(), "tmux-mobile-inventory-fast-path-"),
  );
  const callLog = path.join(fixtureDir, "calls.jsonl");
  const binDir = await makeFakeCommands(fixtureDir);
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ""}`,
      PORT: String(port),
      HOST: "127.0.0.1",
      TMUX_MOBILE_REQUIRE_AUTH: "0",
      TMUX_MOBILE_MUX: "tmux",
      TMUX_MOBILE_MUXES: "",
      TMUX_MOBILE_MUX_COMMAND: "tmux",
      TMUX_MOBILE_PIN_INDEX: "memory",
      TMUX_MOBILE_COMMENT_INDEX: "memory",
      TMUX_MOBILE_ARTIFACT_STORAGE: "local",
      TMUX_MOBILE_ARTIFACT_DIR: path.join(fixtureDir, "artifacts"),
      TMUX_MOBILE_TRANSCRIPT_ARCHIVE_ENABLED: "0",
      TMUX_MOBILE_NTFY_TOPIC: "",
      FAKE_INVENTORY_MODE: mode,
      FAKE_INVENTORY_CALL_LOG: callLog,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  try {
    await waitForHealth(baseUrl, child);
    const response = await fetch(`${baseUrl}/api/command-center`);
    const body = await response.json();
    assert.equal(
      response.status,
      200,
      `${mode} inventory failed: ${JSON.stringify(body)}\n${output}`,
    );
    assert.equal(body.agents.length, 2, `${mode} keeps both agent cards`);
    return { body, calls: await readCalls(callLog) };
  } finally {
    await stopChild(child);
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

{
  const { body, calls } = await runInventory("fast");
  assert.deepEqual(
    body.agents[0].agentMode,
    {
      mode: "fullAccess",
      label: "Full access",
      effort: "high",
      model: "gpt-5.6-terra",
    },
    "inventory carries the model and reasoning effort parsed from the pane footer",
  );
  assert.equal(
    matching(
      calls,
      "ps",
      (args) => args[0] === "-axo" && args.includes("pid=,ppid=,command="),
    ).length,
    1,
    "one inventory round takes one process snapshot",
  );
  assert.equal(
    matching(calls, "lsof").length,
    1,
    "one inventory round takes one global agent-open-files snapshot",
  );
  assert.equal(
    matching(
      calls,
      "lsof",
      (args) => args.join(" ") === "-a -p 100,200 -Fpn",
    ).length,
    1,
    "the open-files snapshot covers every agent pid in one lsof call",
  );
  assert.equal(
    matching(
      calls,
      "tmux",
      (args) => args[0] === "list-windows" && args.includes("-a"),
    ).length,
    1,
    "tree inventory uses one bulk list-windows call",
  );
  assert.equal(
    matching(
      calls,
      "tmux",
      (args) => args[0] === "list-panes" && args.includes("-a"),
    ).length,
    1,
    "surface inventory uses one bulk list-panes call",
  );
  assert.equal(
    matching(
      calls,
      "tmux",
      (args) => args[0] === "list-panes" && !args.includes("-a"),
    ).length,
    0,
    "complete bulk surface output avoids per-window scans",
  );
}

{
  const { calls } = await runInventory("tree-fallback");
  assert.equal(
    matching(calls, "tmux", (args) => args[0] === "list-sessions").length,
    1,
    "an older mux falls back to list-sessions",
  );
  assert.equal(
    matching(
      calls,
      "tmux",
      (args) => args[0] === "list-windows" && args.includes("-t"),
    ).length,
    1,
    "tree fallback lists each session's windows",
  );
}

{
  const { calls } = await runInventory("surfaces-fallback");
  assert.equal(
    matching(
      calls,
      "tmux",
      (args) => args[0] === "list-panes" && args.includes("-a"),
    ).length,
    1,
    "an older mux attempts the bulk surface operation once",
  );
  assert.equal(
    matching(
      calls,
      "tmux",
      (args) => args[0] === "list-panes" && !args.includes("-a"),
    ).length,
    2,
    "bulk surface errors fall back to one scan per window",
  );
}

{
  const { calls } = await runInventory("missing-surface");
  assert.equal(
    matching(
      calls,
      "tmux",
      (args) => args[0] === "list-panes" && !args.includes("-a"),
    ).length,
    1,
    "a window omitted by a racing bulk snapshot gets a targeted fallback scan",
  );
}

console.log("command-center inventory fast-path tests passed");
