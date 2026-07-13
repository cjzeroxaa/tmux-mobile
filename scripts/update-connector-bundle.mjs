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
const launchdLabel =
  process.env.TMUX_MOBILE_UPDATE_LAUNCHD_LABEL || "com.tmux-mobile.agent";
const systemdUnit =
  process.env.TMUX_MOBILE_UPDATE_SYSTEMD_UNIT || "tmux-mobile-agent.service";
const savedEnv = readEnvFile(envFile);
const agentMachine =
  process.env.TMUX_MOBILE_UPDATE_AGENT_MACHINE || savedEnv.AGENT_MACHINE || "";
const targetMux = normalizeMux(
  process.env.TMUX_MOBILE_UPDATE_MUX ||
    process.env.TMUX_MOBILE_MUX ||
    savedEnv.TMUX_MOBILE_MUX ||
    "",
);
const targetMuxes = normalizeMuxes(
  process.env.TMUX_MOBILE_UPDATE_MUXES ||
    process.env.TMUX_MOBILE_MUXES ||
    savedEnv.TMUX_MOBILE_MUXES ||
    "",
);

async function main() {
  log("tmux-mobile connector bundle-update started");
  log(`controller=${controllerUrl}`);
  log(`installDir=${installDir}`);
  if (agentMachine) log(`agentMachine=${agentMachine}`);
  if (targetMux) log(`mux=${targetMux}`);
  if (targetMuxes) log(`muxes=${targetMuxes}`);

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
  writeConnectorEnv({
    AGENT_MACHINE: agentMachine,
    TMUX_MOBILE_MUX: targetMux,
    TMUX_MOBILE_MUXES: targetMuxes,
  });
  await restartConnector(installedRevision);

  log("tmux-mobile connector bundle-update finished");
}

async function restartConnector(installedRevision = "") {
  if (await restartLaunchdConnector()) return;
  if (restartSystemdConnector()) return;

  const oldPids = connectorPids();
  const logFile = path.join(installDir, "connector.log");
  const fd = openSync(logFile, "a");
  const child = spawn(process.execPath, [bundlePath, "--register", controllerUrl], {
    cwd: installDir,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      ...(installedRevision ? { TMUX_MOBILE_REVISION: installedRevision } : {}),
      ...(agentMachine ? { AGENT_MACHINE: agentMachine } : {}),
      ...(targetMux ? { TMUX_MOBILE_MUX: targetMux } : {}),
      ...(targetMuxes ? { TMUX_MOBILE_MUXES: targetMuxes } : {}),
    },
  });
  child.unref();
  closeSync(fd);
  await stopOldConnectorPids(oldPids, { exclude: [child.pid] });
  log(`started connector pid=${child.pid} machine=${agentMachine || "(hostname)"} log=${logFile}`);
}

async function restartLaunchdConnector() {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return false;
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${launchdLabel}`;
  const printed = run("launchctl", ["print", target], { check: false });
  const plistPath =
    parseLaunchdPlistPath(printed.stdout) ||
    path.join(os.homedir(), "Library", "LaunchAgents", `${launchdLabel}.plist`);
  if (!existsSync(plistPath)) return false;

  configureLaunchdPlist(plistPath);
  log(`restart=launchd target=${target} plist=${plistPath}`);
  let stopped = run("launchctl", ["bootout", domain, plistPath], { check: false });
  if (stopped.status !== 0) {
    stopped = run("launchctl", ["bootout", target], { check: false });
  }

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const bootstrap = run("launchctl", ["bootstrap", domain, plistPath], {
      check: false,
    });
    if (bootstrap.status === 0) {
      run("launchctl", ["kickstart", "-k", target], { check: false });
      log(`started connector through launchd target=${target}`);
      return true;
    }
    if (attempt < 8) await sleep(250);
  }
  throw new Error(`could not restart launchd connector ${target}`);
}

function configureLaunchdPlist(plistPath) {
  const plistBuddy = "/usr/libexec/PlistBuddy";
  const logFile = path.join(installDir, "connector.log");
  run(plistBuddy, ["-c", "Delete :ProgramArguments", plistPath], { check: false });
  run(plistBuddy, ["-c", "Add :ProgramArguments array", plistPath]);
  for (const [index, value] of [
    process.execPath,
    bundlePath,
    "--register",
    controllerUrl,
  ].entries()) {
    run(plistBuddy, ["-c", `Add :ProgramArguments:${index} string ${value}`, plistPath]);
  }
  setPlistString(plistBuddy, plistPath, "WorkingDirectory", installDir);
  setPlistString(plistBuddy, plistPath, "StandardOutPath", logFile);
  setPlistString(plistBuddy, plistPath, "StandardErrorPath", logFile);

  const environmentExists = run(
    plistBuddy,
    ["-c", "Print :EnvironmentVariables", plistPath],
    { check: false },
  );
  if (environmentExists.status !== 0) {
    run(plistBuddy, ["-c", "Add :EnvironmentVariables dict", plistPath]);
  }
  for (const [key, value] of Object.entries({
    AGENT_MACHINE: agentMachine,
    TMUX_MOBILE_MUX: targetMux,
    TMUX_MOBILE_MUXES: targetMuxes,
  })) {
    if (value) setPlistString(plistBuddy, plistPath, `EnvironmentVariables:${key}`, value);
  }
  run("plutil", ["-lint", plistPath]);
}

function setPlistString(plistBuddy, plistPath, key, value) {
  const set = run(plistBuddy, ["-c", `Set :${key} ${value}`, plistPath], {
    check: false,
  });
  if (set.status !== 0) {
    run(plistBuddy, ["-c", `Add :${key} string ${value}`, plistPath]);
  }
}

function parseLaunchdPlistPath(text) {
  return String(text || "").match(/^\s*path = (.+\.plist)\s*$/m)?.[1]?.trim() || "";
}

function restartSystemdConnector() {
  if (process.platform !== "linux") return false;
  const loaded = run(
    "systemctl",
    ["--user", "show", systemdUnit, "--property=LoadState", "--value"],
    { check: false },
  );
  if (loaded.status !== 0 || loaded.stdout.trim() !== "loaded") return false;

  const dropInDir = path.join(
    os.homedir(),
    ".config",
    "systemd",
    "user",
    `${systemdUnit}.d`,
  );
  mkdirSync(dropInDir, { recursive: true });
  const environment = [
    agentMachine ? `Environment=AGENT_MACHINE=${systemdQuote(agentMachine)}` : "",
    targetMux ? `Environment=TMUX_MOBILE_MUX=${systemdQuote(targetMux)}` : "",
    targetMuxes ? `Environment=TMUX_MOBILE_MUXES=${systemdQuote(targetMuxes)}` : "",
  ].filter(Boolean);
  const override = [
    "[Service]",
    "ExecStart=",
    `ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(bundlePath)} --register ${systemdQuote(controllerUrl)}`,
    `WorkingDirectory=${systemdQuote(installDir)}`,
    ...environment,
    "",
  ].join("\n");
  writeFileSync(path.join(dropInDir, "tmux-mobile-bundle.conf"), override);
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "restart", systemdUnit]);
  log(`started connector through systemd unit=${systemdUnit}`);
  return true;
}

function systemdQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
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

function writeConnectorEnv(values) {
  const lines = [];
  for (const [key, value] of Object.entries(values)) {
    if (value) lines.push(`${key}=${value}`);
  }
  if (lines.length === 0) return;
  writeFileSync(envFile, `${lines.join("\n")}\n`, "utf8");
  log(`wrote connector env ${envFile}`);
}

function normalizeMux(value) {
  const mux = String(value || "").trim().toLowerCase();
  return mux === "tmux" || mux === "rmux" ? mux : "";
}

function normalizeMuxes(value) {
  const muxes = String(value || "")
    .split(",")
    .map(normalizeMux)
    .filter(Boolean);
  return [...new Set(muxes)].join(",");
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
