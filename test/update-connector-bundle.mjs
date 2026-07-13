import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

globalThis.__TMUX_MOBILE_UPDATE_BUNDLE_TEST__ = true;
const {
  configureLaunchdPlist,
  launchdRunningService,
  restartConnector,
  restartLaunchdConnector,
  stopOldConnectorPids,
  systemdRunningService,
} = await import("../scripts/update-connector-bundle.mjs");

const dir = await mkdtemp(path.join(os.tmpdir(), "tmux-mobile-bundle-updater-"));

try {
  // Plist edits happen only in a sibling temporary file. The validated file is
  // atomically renamed into place, and the returned recovery handle restores
  // the exact original bytes the same way.
  const plistPath = path.join(dir, "connector.plist");
  await writeFile(plistPath, "original plist\n");
  const editedPaths = [];
  const update = configureLaunchdPlist(plistPath, {
    runCommand(command, args) {
      const candidate = args.at(-1);
      if (command.endsWith("PlistBuddy")) {
        editedPaths.push(candidate);
        if (args[1] === "Delete :ProgramArguments") {
          writeFileSync(candidate, "updated plist\n");
          return { status: 0, stdout: "", stderr: "" };
        }
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(await readFile(plistPath, "utf8"), "updated plist\n");
  assert.ok(editedPaths.length > 0);
  assert.ok(editedPaths.every((candidate) => candidate !== plistPath));
  update.restore();
  assert.equal(await readFile(plistPath, "utf8"), "original plist\n");

  // A failed lint never replaces or truncates the live plist and cleans its
  // temporary file.
  const failedPlistPath = path.join(dir, "failed.plist");
  await writeFile(failedPlistPath, "still valid\n");
  assert.throws(
    () =>
      configureLaunchdPlist(failedPlistPath, {
        runCommand(command, args) {
          const candidate = args.at(-1);
          if (command.endsWith("PlistBuddy") && args[1] === "Delete :ProgramArguments") {
            // A partial edit is confined to the temporary sibling.
            writeFileSync(candidate, "partial\n");
            return { status: 0, stdout: "", stderr: "" };
          }
          if (command === "plutil") throw new Error("lint failed");
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    /lint failed/,
  );
  assert.equal(await readFile(failedPlistPath, "utf8"), "still valid\n");
  assert.deepEqual(
    (await readdir(dir)).filter((name) => name.includes("failed.plist.tmp-")),
    [],
  );

  // A launchd restart is successful only after launchctl reports a running job
  // with a concrete pid; bootstrap alone is insufficient.
  {
    let loaded = true;
    let running = true;
    let pid = 101;
    let restored = false;
    let kickstarts = 0;
    const result = await restartLaunchdConnector({
      platform: "darwin",
      getuid: () => 501,
      exists: () => true,
      sleepImpl: async () => {},
      configurePlist: () => ({
        restore() {
          restored = true;
        },
      }),
      runCommand(command, args) {
        assert.equal(command, "launchctl");
        const operation = args[0];
        if (operation === "print") {
          return loaded
            ? {
                status: 0,
                stdout: `path = ${plistPath}\nstate = ${running ? "running" : "waiting"}\npid = ${pid}\n`,
                stderr: "",
              }
            : { status: 113, stdout: "", stderr: "not found" };
        }
        if (operation === "bootout") {
          loaded = false;
          running = false;
          return { status: 0, stdout: "", stderr: "" };
        }
        if (operation === "enable") return { status: 0, stdout: "", stderr: "" };
        if (operation === "bootstrap") {
          loaded = true;
          running = false;
          pid = 202;
          return { status: 0, stdout: "", stderr: "" };
        }
        if (operation === "kickstart") {
          kickstarts += 1;
          running = true;
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected launchctl operation ${operation}`);
      },
    });
    assert.deepEqual(result, { manager: "launchd", pid: 202 });
    assert.equal(kickstarts, 1);
    assert.equal(restored, false);
  }

  // If the updated job never reaches running, restore the original plist and
  // bring the previously-loaded job back before surfacing the update failure.
  {
    let loaded = true;
    let running = true;
    let pid = 301;
    let updated = false;
    let restored = false;
    await assert.rejects(
      restartLaunchdConnector({
        platform: "darwin",
        getuid: () => 501,
        exists: () => true,
        sleepImpl: async () => {},
        configurePlist: () => {
          updated = true;
          return {
            restore() {
              updated = false;
              restored = true;
            },
          };
        },
        runCommand(_command, args) {
          const operation = args[0];
          if (operation === "print") {
            return loaded
              ? {
                  status: 0,
                  stdout: `path = ${plistPath}\nstate = ${running ? "running" : "waiting"}\npid = ${pid}\n`,
                  stderr: "",
                }
              : { status: 113, stdout: "", stderr: "not found" };
          }
          if (operation === "bootout") {
            loaded = false;
            running = false;
            return { status: 0, stdout: "", stderr: "" };
          }
          if (operation === "enable") return { status: 0, stdout: "", stderr: "" };
          if (operation === "bootstrap") {
            if (updated) return { status: 5, stdout: "", stderr: "bad plist" };
            loaded = true;
            running = false;
            pid = 302;
            return { status: 0, stdout: "", stderr: "" };
          }
          if (operation === "kickstart") {
            if (updated) return { status: 5, stdout: "", stderr: "not loaded" };
            running = true;
            return { status: 0, stdout: "", stderr: "" };
          }
          throw new Error(`unexpected launchctl operation ${operation}`);
        },
      }),
      /could not start launchd connector/,
    );
    assert.equal(restored, true);
    assert.equal(updated, false);
    assert.equal(loaded, true);
    assert.equal(running, true);
    assert.equal(pid, 302);
  }

  // Manager restarts clean the connector pid snapshot while explicitly
  // preserving both the verified replacement pid and the updater itself.
  {
    let stopped = null;
    await restartConnector("revision", {
      connectorPidsImpl: () => [401, 402, 403],
      restartLaunchdImpl: async () => ({ manager: "launchd", pid: 402 }),
      restartSystemdImpl: async () => {
        throw new Error("systemd must not run after launchd success");
      },
      stopOldConnectorPidsImpl: async (pids, options) => {
        stopped = { pids, options };
      },
    });
    assert.deepEqual(stopped, {
      pids: [401, 402, 403],
      options: { exclude: [402] },
    });

    const detachedOrder = [];
    await restartConnector("revision", {
      connectorPidsImpl: () => [451],
      restartLaunchdImpl: async () => false,
      restartSystemdImpl: async () => false,
      stopOldConnectorPidsImpl: async (pids) => {
        detachedOrder.push(["stop", pids]);
      },
      startDetachedConnectorImpl: async (revision) => {
        detachedOrder.push(["start", revision]);
      },
    });
    assert.deepEqual(detachedOrder, [
      ["stop", [451]],
      ["start", "revision"],
    ]);

    const signals = [];
    await stopOldConnectorPids([501, 502, 503], {
      currentPid: 501,
      exclude: [502],
      killImpl: (pid, signal) => signals.push([pid, signal]),
      sleepImpl: async () => {},
    });
    assert.deepEqual(signals, [
      [503, "SIGTERM"],
      [503, "SIGKILL"],
    ]);
  }

  assert.deepEqual(
    launchdRunningService({ status: 0, stdout: "state = running\npid = 601\n" }),
    { pid: 601, state: "running" },
  );
  assert.equal(
    launchdRunningService({ status: 0, stdout: "state = waiting\npid = 601\n" }),
    null,
  );
  assert.deepEqual(
    systemdRunningService({
      status: 0,
      stdout: "ActiveState=active\nSubState=running\nMainPID=602\n",
    }),
    { pid: 602, state: "running" },
  );
  assert.equal(
    systemdRunningService({
      status: 0,
      stdout: "ActiveState=active\nSubState=failed\nMainPID=0\n",
    }),
    null,
  );

  console.log("connector bundle updater tests passed");
} finally {
  await rm(dir, { recursive: true, force: true });
  delete globalThis.__TMUX_MOBILE_UPDATE_BUNDLE_TEST__;
}
