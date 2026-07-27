import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = path.join(root, "dist", "tmux-mobile-connector.mjs");
const home = await mkdtemp(path.join(tmpdir(), "tmux-mobile-bundle-home-"));
const child = spawn(process.execPath, [bundle], {
  cwd: home,
  env: {
    ...process.env,
    HOME: home,
    HOST: "127.0.0.1",
    PORT: "0",
    TMUX_MOBILE_PIN_INDEX: "memory",
    TMUX_MOBILE_COMMENT_INDEX: "memory",
    TMUX_MOBILE_ARTIFACT_STORAGE: "local",
    TMUX_MOBILE_TRANSCRIPT_ARCHIVE_ENABLED: "0",
    TMUX_MOBILE_NTFY_TOPIC: "",
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
  await Promise.race([
    new Promise((resolve, reject) => {
      const check = () => {
        if (output.includes("tmux local listening")) return resolve();
        if (child.exitCode !== null) {
          return reject(
            new Error(`standalone bundle exited early (${child.exitCode}):\n${output}`),
          );
        }
        setTimeout(check, 20);
      };
      check();
    }),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`standalone bundle did not start:\n${output}`)),
        10_000,
      ),
    ),
  ]);
  assert.doesNotMatch(output, /access-control\.json/);
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(home, { recursive: true, force: true });
}

console.log("standalone connector bundle startup test passed");
