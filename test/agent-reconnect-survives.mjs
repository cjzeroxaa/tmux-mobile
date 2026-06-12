// Regression test for a process-liveness bug: after a disconnect the agent
// schedules a reconnect via setTimeout. If that timer is unref'd (or nothing
// else holds the event loop), the Node process exits *during* the backoff
// instead of dialing again — the agent silently dies. This bit us in production
// after a revision-change re-dial (logged "reconnect scheduled", then exited).
//
// We run the agent in a child process pointed at a controller that NEVER comes
// up, so the child's only live handle is its reconnect timer. If that timer
// keeps the loop alive (correct), the child is still running after several
// backoff cycles. If it were unref'd (the bug), the child would exit ~0 almost
// immediately. We assert the child is still alive.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const childScript = `
import { runAgent } from ${JSON.stringify(path.join(root, "lib/agent.mjs"))};
runAgent("http://127.0.0.1:59997", {
  tmux: async () => "t", readdir: async () => [], branch: async () => ({ branch: "", worktree: false }),
});
`;

const child = spawn(
  process.execPath,
  ["--input-type=module", "-e", childScript],
  {
    env: {
      ...process.env,
      AGENT_MACHINE: "reconnect-survives",
      AGENT_REVISION_POLL_MS: "0",
      AGENT_PING_INTERVAL_MS: "100",
      AGENT_PONG_TIMEOUT_MS: "300",
      AGENT_MAX_BACKOFF_MS: "200",
      TMUX_MOBILE_AGENT_ID: "10000000-0000-4000-8000-000000000008",
    },
    stdio: "ignore",
  },
);

let exited = false;
let exitInfo = null;
child.on("exit", (code, signal) => {
  exited = true;
  exitInfo = { code, signal };
});

// The connection to :59997 fails immediately; the agent should schedule a
// reconnect and stay alive across many backoff cycles. Give it well past
// several MAX_BACKOFF (200ms) intervals.
await new Promise((resolve) => setTimeout(resolve, 2_000));

try {
  assert.equal(
    exited,
    false,
    `agent exited during reconnect backoff instead of staying alive: ${JSON.stringify(exitInfo)}`,
  );
  console.log("agent reconnect-survives e2e passed");
  child.kill("SIGKILL");
  process.exit(0);
} catch (error) {
  console.error(error.message);
  try {
    child.kill("SIGKILL");
  } catch {}
  process.exit(1);
}
