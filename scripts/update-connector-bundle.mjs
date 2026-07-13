#!/usr/bin/env node
// tmux-mobile connector self-update — clone-free. Downloads the latest
// self-contained connector bundle from the controller and restarts the running
// connector. No git checkout, no npm install. Mirrors update-connector.mjs's
// trigger format (`curl <url> | node --input-type=module`) but pulls the bundle
// the controller serves at /connector/tmux-mobile-connector.mjs instead of
// pulling a git repo.

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

async function restartConnector(installedRevision = "", options = {}) {
  const connectorPidsImpl = options.connectorPidsImpl || connectorPids;
  const restartLaunchdImpl = options.restartLaunchdImpl || restartLaunchdConnector;
  const restartSystemdImpl = options.restartSystemdImpl || restartSystemdConnector;
  const stopOldConnectorPidsImpl =
    options.stopOldConnectorPidsImpl || stopOldConnectorPids;
  const startDetachedConnectorImpl =
    options.startDetachedConnectorImpl || startDetachedConnector;
  const oldPids = connectorPidsImpl();

  const launchd = await restartLaunchdImpl();
  if (launchd) {
    await stopOldConnectorPidsImpl(oldPids, { exclude: [launchd.pid] });
    return;
  }
  const systemd = await restartSystemdImpl();
  if (systemd) {
    await stopOldConnectorPidsImpl(oldPids, { exclude: [systemd.pid] });
    return;
  }

  // The Connector now owns a per-controller + agent-identity singleton lock.
  // A detached replacement cannot acquire it while the old process is still
  // alive, so complete shutdown before spawning the replacement.
  await stopOldConnectorPidsImpl(oldPids);
  await startDetachedConnectorImpl(installedRevision);
}

async function startDetachedConnector(installedRevision = "") {
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
  log(`started connector pid=${child.pid} machine=${agentMachine || "(hostname)"} log=${logFile}`);
}

async function restartLaunchdConnector(options = {}) {
  const platform = options.platform || process.platform;
  const getuid = options.getuid || process.getuid;
  const runCommand = options.runCommand || run;
  const exists = options.exists || existsSync;
  const configurePlist =
    options.configurePlist ||
    ((plistPath) => configureLaunchdPlist(plistPath, { runCommand }));
  const sleepImpl = options.sleepImpl || sleep;
  if (platform !== "darwin" || typeof getuid !== "function") return false;
  const domain = `gui/${getuid()}`;
  const target = `${domain}/${launchdLabel}`;
  const printed = runCommand("launchctl", ["print", target], { check: false });
  const plistPath =
    parseLaunchdPlistPath(printed.stdout) ||
    path.join(os.homedir(), "Library", "LaunchAgents", `${launchdLabel}.plist`);
  if (!exists(plistPath)) {
    if (printed.status === 0) {
      throw new Error(`loaded launchd connector has no readable plist at ${plistPath}`);
    }
    return false;
  }

  const wasLoaded = printed.status === 0;
  const plistUpdate = configurePlist(plistPath);
  try {
    log(`restart=launchd target=${target} plist=${plistPath}`);
    if (wasLoaded) {
      let stopped = runCommand("launchctl", ["bootout", domain, plistPath], {
        check: false,
      });
      if (stopped.status !== 0) {
        stopped = runCommand("launchctl", ["bootout", target], { check: false });
      }
      if (!(await waitForLaunchdUnloaded(target, { runCommand, sleepImpl }))) {
        throw new Error(`launchd connector ${target} did not unload`);
      }
    }

    const started = await startAndVerifyLaunchdService(domain, target, plistPath, {
      runCommand,
      sleepImpl,
    });
    if (!started) throw new Error(`could not start launchd connector ${target}`);
    log(`started connector through launchd target=${target} pid=${started.pid}`);
    return { manager: "launchd", pid: started.pid };
  } catch (error) {
    let recoveryError = null;
    try {
      const partiallyLoaded = runCommand("launchctl", ["print", target], {
        check: false,
      });
      if (partiallyLoaded.status === 0) {
        runCommand("launchctl", ["bootout", target], { check: false });
        const unloaded = await waitForLaunchdUnloaded(target, {
          runCommand,
          sleepImpl,
        });
        if (!unloaded) {
          // Restore the on-disk plist below, but do not claim that the original
          // job was recovered while launchd still has the replacement loaded.
          plistUpdate.restore();
          throw new Error(`could not unload failed launchd connector ${target}`);
        }
      }
      plistUpdate.restore();
      if (wasLoaded) {
        const recovered = await startAndVerifyLaunchdService(
          domain,
          target,
          plistPath,
          { runCommand, sleepImpl },
        );
        if (!recovered) {
          throw new Error(`could not restore original launchd connector ${target}`);
        }
        log(`restored original launchd connector target=${target} pid=${recovered.pid}`);
      }
    } catch (restoreError) {
      recoveryError = restoreError;
    }
    if (recoveryError) {
      throw new Error(
        `${error.message}; launchd recovery also failed: ${recoveryError.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

let atomicPlistSequence = 0;

function configureLaunchdPlist(plistPath, { runCommand = run } = {}) {
  const original = readFileSync(plistPath);
  const originalMode = statSync(plistPath).mode & 0o7777;
  const tempPath = `${plistPath}.tmp-${process.pid}-${++atomicPlistSequence}`;
  writeFileSync(tempPath, original, { flag: "wx", mode: originalMode });
  chmodSync(tempPath, originalMode);

  const plistBuddy = "/usr/libexec/PlistBuddy";
  const logFile = path.join(installDir, "connector.log");
  try {
    runCommand(plistBuddy, ["-c", "Delete :ProgramArguments", tempPath], {
      check: false,
    });
    runCommand(plistBuddy, ["-c", "Add :ProgramArguments array", tempPath]);
    for (const [index, value] of [
      process.execPath,
      bundlePath,
      "--register",
      controllerUrl,
    ].entries()) {
      runCommand(plistBuddy, [
        "-c",
        `Add :ProgramArguments:${index} string ${value}`,
        tempPath,
      ]);
    }
    setPlistString(plistBuddy, tempPath, "WorkingDirectory", installDir, runCommand);
    setPlistString(plistBuddy, tempPath, "StandardOutPath", logFile, runCommand);
    setPlistString(plistBuddy, tempPath, "StandardErrorPath", logFile, runCommand);

    const environmentExists = runCommand(
      plistBuddy,
      ["-c", "Print :EnvironmentVariables", tempPath],
      { check: false },
    );
    if (environmentExists.status !== 0) {
      runCommand(plistBuddy, ["-c", "Add :EnvironmentVariables dict", tempPath]);
    }
    for (const [key, value] of Object.entries({
      AGENT_MACHINE: agentMachine,
      TMUX_MOBILE_MUX: targetMux,
      TMUX_MOBILE_MUXES: targetMuxes,
    })) {
      if (value) {
        setPlistString(
          plistBuddy,
          tempPath,
          `EnvironmentVariables:${key}`,
          value,
          runCommand,
        );
      }
    }
    runCommand("plutil", ["-lint", tempPath]);
    renameSync(tempPath, plistPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }

  let restored = false;
  return {
    restore() {
      if (restored) return;
      const restorePath = `${plistPath}.restore-${process.pid}-${++atomicPlistSequence}`;
      try {
        writeFileSync(restorePath, original, { flag: "wx", mode: originalMode });
        chmodSync(restorePath, originalMode);
        runCommand("plutil", ["-lint", restorePath]);
        renameSync(restorePath, plistPath);
        restored = true;
      } catch (error) {
        rmSync(restorePath, { force: true });
        throw error;
      }
    },
  };
}

function setPlistString(plistBuddy, plistPath, key, value, runCommand = run) {
  const set = runCommand(plistBuddy, ["-c", `Set :${key} ${value}`, plistPath], {
    check: false,
  });
  if (set.status !== 0) {
    runCommand(plistBuddy, ["-c", `Add :${key} string ${value}`, plistPath]);
  }
}

function parseLaunchdPlistPath(text) {
  return String(text || "").match(/^\s*path = (.+\.plist)\s*$/m)?.[1]?.trim() || "";
}

async function waitForLaunchdUnloaded(
  target,
  { runCommand = run, sleepImpl = sleep, attempts = 8 } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const printed = runCommand("launchctl", ["print", target], { check: false });
    if (printed.status !== 0) return true;
    if (attempt < attempts) await sleepImpl(250);
  }
  return false;
}

async function startAndVerifyLaunchdService(
  domain,
  target,
  plistPath,
  { runCommand = run, sleepImpl = sleep, attempts = 8 } = {},
) {
  runCommand("launchctl", ["enable", target], { check: false });
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let printed = runCommand("launchctl", ["print", target], { check: false });
    let running = launchdRunningService(printed);
    if (running) return running;

    if (printed.status !== 0) {
      const bootstrap = runCommand("launchctl", ["bootstrap", domain, plistPath], {
        check: false,
      });
      if (bootstrap.status === 0) {
        printed = runCommand("launchctl", ["print", target], { check: false });
        running = launchdRunningService(printed);
        if (running) return running;
      }
    }

    const kickstart = runCommand("launchctl", ["kickstart", "-k", target], {
      check: false,
    });
    printed = runCommand("launchctl", ["print", target], { check: false });
    running = launchdRunningService(printed);
    if (running) return running;
    if (kickstart.status !== 0) {
      log(`launchd kickstart failed target=${target} attempt=${attempt}`);
    }
    if (attempt < attempts) await sleepImpl(250);
  }
  return null;
}

function launchdRunningService(result) {
  if (result?.status !== 0) return null;
  const text = String(result.stdout || "");
  const state = text.match(/^\s*state = (\S+)\s*$/m)?.[1] || "";
  const pid = Number(text.match(/^\s*pid = (\d+)\s*$/m)?.[1] || 0);
  return state === "running" && Number.isInteger(pid) && pid > 0
    ? { pid, state }
    : null;
}

async function restartSystemdConnector(options = {}) {
  const platform = options.platform || process.platform;
  const runCommand = options.runCommand || run;
  const sleepImpl = options.sleepImpl || sleep;
  if (platform !== "linux") return false;
  const loaded = runCommand(
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
  runCommand("systemctl", ["--user", "daemon-reload"]);
  runCommand("systemctl", ["--user", "restart", systemdUnit]);
  const started = await waitForSystemdRunning(systemdUnit, { runCommand, sleepImpl });
  if (!started) throw new Error(`systemd connector ${systemdUnit} did not reach running`);
  log(`started connector through systemd unit=${systemdUnit} pid=${started.pid}`);
  return { manager: "systemd", pid: started.pid };
}

async function waitForSystemdRunning(
  unit,
  { runCommand = run, sleepImpl = sleep, attempts = 8 } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const shown = runCommand(
      "systemctl",
      [
        "--user",
        "show",
        unit,
        "--property=ActiveState",
        "--property=SubState",
        "--property=MainPID",
      ],
      { check: false },
    );
    const running = systemdRunningService(shown);
    if (running) return running;
    if (attempt < attempts) await sleepImpl(250);
  }
  return null;
}

function systemdRunningService(result) {
  if (result?.status !== 0) return null;
  const values = Object.fromEntries(
    String(result.stdout || "")
      .split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2))
      .filter(([key]) => key),
  );
  const pid = Number(values.MainPID || 0);
  return values.ActiveState === "active" && values.SubState === "running" &&
    Number.isInteger(pid) && pid > 0
    ? { pid, state: values.SubState }
    : null;
}

function systemdQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

async function stopOldConnectorPids(
  oldPids,
  {
    exclude = [],
    currentPid = process.pid,
    killImpl = process.kill,
    sleepImpl = sleep,
  } = {},
) {
  const excludeSet = new Set(
    [currentPid, ...exclude].filter((pid) => Number.isInteger(pid) && pid > 0),
  );
  for (const pid of oldPids) {
    if (excludeSet.has(pid)) continue;
    try {
      killImpl(pid, "SIGTERM");
      log(`stopped old connector pid=${pid}`);
    } catch {}
  }
  await sleepImpl(1500);
  for (const pid of oldPids) {
    if (excludeSet.has(pid)) continue;
    try {
      killImpl(pid, "SIGKILL");
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

if (globalThis.__TMUX_MOBILE_UPDATE_BUNDLE_TEST__ !== true) {
  main().catch(async (error) => {
    await log(`FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  configureLaunchdPlist,
  launchdRunningService,
  restartConnector,
  restartLaunchdConnector,
  restartSystemdConnector,
  stopOldConnectorPids,
  systemdRunningService,
};
