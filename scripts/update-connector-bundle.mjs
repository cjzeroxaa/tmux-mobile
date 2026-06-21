#!/usr/bin/env node
// tmux-mobile connector self-update — clone-free. Downloads the latest
// self-contained connector bundle from the controller and restarts the running
// connector. No git checkout, no npm install. Mirrors update-connector.mjs's
// trigger format (`curl <url> | node --input-type=module`) but pulls the bundle
// the controller serves at /connector/tmux-mobile-connector.mjs instead of
// pulling a git repo.

import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const DEFAULT_CONTROLLER = "https://eng.impo.ai";
const controllerUrl = (process.env.TMUX_MOBILE_UPDATE_CONTROLLER || DEFAULT_CONTROLLER).replace(/\/+$/, "");
const installDir = expandHome(
  process.env.TMUX_MOBILE_DIR || path.join(os.homedir(), ".local", "share", "tmux-mobile"),
);
const bundlePath = path.join(installDir, "tmux-mobile-connector.mjs");
const envFile = path.join(installDir, "connector.env");
const expectedRevision = process.env.TMUX_MOBILE_UPDATE_EXPECTED_REVISION || "";
const logPath =
  process.env.TMUX_MOBILE_UPDATE_LOG || path.join(os.tmpdir(), "tmux-mobile-connector-update.log");
const bundleUrl = `${controllerUrl}/connector/tmux-mobile-connector.mjs`;
const manifestUrl = `${controllerUrl}/connector/tmux-mobile-connector.json`;

async function main() {
  log("tmux-mobile connector bundle-update started");
  log(`controller=${controllerUrl}`);
  log(`installDir=${installDir}`);

  mkdirSync(installDir, { recursive: true });

  // Download the bundle to a temp file, then atomically swap it in.
  log(`downloading ${bundleUrl}`);
  const bundle = await fetchBuffer(bundleUrl);
  const tmp = `${bundlePath}.tmp.${process.pid}`;
  writeFileSync(tmp, bundle);
  renameSync(tmp, bundlePath);
  log(`installed ${bundlePath} (${bundle.length} bytes)`);

  // Optional revision check against the manifest the controller publishes.
  const manifest = await fetchJson(manifestUrl).catch(() => null);
  const installedRevision = manifest?.revision || "";
  if (installedRevision) log(`bundleRevision=${installedRevision}`);
  if (expectedRevision && !revisionMatches(installedRevision, normalizeRevision(expectedRevision))) {
    throw new Error(`downloaded revision ${installedRevision || "?"}, expected ${expectedRevision}`);
  }

  run(process.execPath, ["--check", bundlePath]);
  await restartConnector();

  log("tmux-mobile connector bundle-update finished");
}

const agentMachine =
  process.env.TMUX_MOBILE_UPDATE_AGENT_MACHINE || readEnvFile(envFile).AGENT_MACHINE || "";

async function restartConnector() {
  const oldPids = connectorPids();
  const logFile = path.join(installDir, "connector.log");
  const fd = openSync(logFile, "a");
  const child = spawn(process.execPath, [bundlePath, "--register", controllerUrl], {
    cwd: installDir,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      ...(agentMachine ? { AGENT_MACHINE: agentMachine } : {}),
    },
  });
  child.unref();
  closeSync(fd);
  await stopOldConnectorPids(oldPids, { exclude: [child.pid] });
  log(`started connector pid=${child.pid} machine=${agentMachine || "(hostname)"} log=${logFile}`);
}

async function stopOldConnectorPids(oldPids, { exclude = [] } = {}) {
  const excludeSet = new Set([process.pid, ...exclude].filter((pid) => Number.isInteger(pid)));
  for (const pid of oldPids) {
    if (excludeSet.has(pid)) continue;
    try {
      process.kill(pid, "SIGTERM");
      log(`stopped old connector pid=${pid}`);
    } catch {}
  }
  await sleep(1500);
  for (const pid of oldPids) {
    if (excludeSet.has(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
      log(`killed old connector pid=${pid}`);
    } catch {}
  }
}

function connectorPids() {
  const result = run("ps", ["-axo", "pid=,command="], { check: false });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      const pid = Number(match[1]);
      const command = match[2];
      // Match either the bundle connector or a repo connector for this controller.
      if (!/tmux-mobile-connector\.mjs|server\.mjs/.test(command)) return null;
      if (!command.includes("--register")) return null;
      if (controllerUrl && !command.includes(controllerUrl)) return null;
      return pid;
    })
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`download failed ${response.status} for ${url}`);
  return response.json();
}

function readEnvFile(filePath) {
  const out = {};
  if (!existsSync(filePath)) return out;
  try {
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match) out[match[1]] = match[2].trim();
    }
  } catch {}
  return out;
}

function run(command, args, { cwd = process.cwd(), check = true } = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (stdout.trim()) log(stdout.trimEnd());
  if (stderr.trim()) log(stderr.trimEnd());
  if (check && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
  }
  return { status: result.status ?? 1, stdout, stderr };
}

function expandHome(value) {
  const raw = String(value || "").trim();
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return raw || path.join(os.homedir(), ".local", "share", "tmux-mobile");
}

function normalizeRevision(value) {
  return String(value || "").trim().replace(/-dirty$/, "");
}

function revisionMatches(actual, expected) {
  if (!actual || !expected) return false;
  return actual === expected || actual.startsWith(expected) || expected.startsWith(actual);
}

async function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    await appendFile(logPath, `${line}\n`);
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(async (error) => {
  await log(`FAILED: ${error.message}`);
  process.exitCode = 1;
});
