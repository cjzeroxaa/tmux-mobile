#!/usr/bin/env node
import { existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const DEFAULT_REPO_DIR = "~/src/tmux-mobile";
const DEFAULT_CONTROLLER = "https://eng.impo.ai";
const DEFAULT_CLONE_URL = "https://github.com/cjzeroxaa/tmux-mobile.git";
const DEFAULT_TARGET_REF = "main";
const LAUNCHD_LABEL = process.env.TMUX_MOBILE_UPDATE_LAUNCHD_LABEL || "com.tmux-mobile.agent";
const SYSTEMD_UNIT = process.env.TMUX_MOBILE_UPDATE_SYSTEMD_UNIT || "tmux-mobile-agent.service";

const repoDir = expandHome(process.env.TMUX_MOBILE_UPDATE_REPO || DEFAULT_REPO_DIR);
const controllerUrl = process.env.TMUX_MOBILE_UPDATE_CONTROLLER || DEFAULT_CONTROLLER;
const cloneUrl = process.env.TMUX_MOBILE_UPDATE_CLONE_URL || DEFAULT_CLONE_URL;
const expectedRevision = process.env.TMUX_MOBILE_UPDATE_EXPECTED_REVISION || "";
const targetRef = process.env.TMUX_MOBILE_UPDATE_REF || DEFAULT_TARGET_REF;
const logPath =
  process.env.TMUX_MOBILE_UPDATE_LOG ||
  path.join(os.tmpdir(), "tmux-mobile-connector-update.log");

async function main() {
  log(`tmux-mobile connector update started`);
  log(`repo=${repoDir}`);
  log(`controller=${controllerUrl}`);
  log(`targetRef=${targetRef}`);
  if (expectedRevision) log(`expectedRevision=${expectedRevision}`);

  ensureRepo();
  git(["fetch", "--all", "--prune"]);
  checkoutTargetRef();
  git(["pull", "--ff-only", "origin", targetRef]);
  verifyExpectedRevision();

  run("npm", ["install", "--omit=dev"], { cwd: repoDir });
  run(process.execPath, ["--check", "server.mjs"], { cwd: repoDir });
  run(process.execPath, ["--check", "lib/agent.mjs"], { cwd: repoDir });
  await restartConnector();

  log("tmux-mobile connector update finished");
}

function ensureRepo() {
  if (!existsSync(repoDir)) {
    mkdirSync(path.dirname(repoDir), { recursive: true });
    run("git", ["clone", cloneUrl, repoDir]);
  }
  const result = run("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: repoDir,
    check: false,
  });
  if (result.status !== 0 || result.stdout.trim() !== "true") {
    throw new Error(`${repoDir} is not a git checkout`);
  }
}

function checkoutTargetRef() {
  const current = git(["rev-parse", "--abbrev-ref", "HEAD"], { check: false }).stdout.trim();
  if (current === targetRef) return;

  const checkout = git(["checkout", targetRef], { check: false });
  if (checkout.status === 0) return;

  git(["checkout", "-b", targetRef, `origin/${targetRef}`]);
}

function verifyExpectedRevision() {
  const expected = normalizeRevision(expectedRevision);
  if (!expected) return;

  const full = git(["rev-parse", "HEAD"]).stdout.trim();
  const short = git(["rev-parse", "--short", "HEAD"]).stdout.trim();
  if (revisionMatches(short, expected) || revisionMatches(full, expected)) {
    log(`updatedRevision=${short}`);
    return;
  }
  throw new Error(`updated to ${short}, expected ${expected}`);
}

async function restartConnector() {
  if (restartLaunchd()) return;
  if (restartSystemd()) return;
  await restartDetachedProcess();
}

function restartLaunchd() {
  if (process.platform !== "darwin") return false;
  const uid = process.getuid ? process.getuid() : process.env.UID;
  const target = `gui/${uid}/${LAUNCHD_LABEL}`;
  const printed = run("launchctl", ["print", target], { check: false });
  if (printed.status !== 0) return false;

  log(`restart=launchd target=${target}`);
  run("launchctl", ["kickstart", "-k", target]);
  return true;
}

function restartSystemd() {
  if (process.platform === "darwin") return false;
  if (!commandExists("systemctl")) return false;
  const known =
    run("systemctl", ["--user", "is-active", "--quiet", SYSTEMD_UNIT], { check: false }).status === 0 ||
    run("systemctl", ["--user", "cat", SYSTEMD_UNIT], { check: false }).status === 0;
  if (!known) return false;

  log(`restart=systemd unit=${SYSTEMD_UNIT}`);
  run("systemctl", ["--user", "daemon-reload"], { check: false });
  run("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
  return true;
}

async function restartDetachedProcess() {
  log("restart=detached-process");
  const oldPids = connectorPids();
  const logFile = path.join(os.tmpdir(), "tmux-mobile-agent.log");
  const fd = openSync(logFile, "a");
  const child = spawn(process.execPath, ["server.mjs", "--register", controllerUrl], {
    cwd: repoDir,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });
  child.unref();
  closeSync(fd);

  for (const pid of oldPids) {
    if (pid === process.pid || pid === child.pid) continue;
    try {
      process.kill(pid, "SIGTERM");
      log(`stopped old connector pid=${pid}`);
    } catch {}
  }
  await sleep(1500);
  for (const pid of oldPids) {
    if (pid === process.pid || pid === child.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
      log(`killed old connector pid=${pid}`);
    } catch {}
  }
  log(`started connector pid=${child.pid} log=${logFile}`);
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
      if (!command.includes("server.mjs")) return null;
      if (!command.includes("--register")) return null;
      if (controllerUrl && !command.includes(controllerUrl)) return null;
      return pid;
    })
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function git(args, options = {}) {
  return run("git", args, { cwd: repoDir, ...options });
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

function commandExists(command) {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function expandHome(value) {
  const raw = String(value || "").trim();
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return raw || path.join(os.homedir(), "src", "tmux-mobile");
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
