import assert from "node:assert/strict";
import {
  createTmuxWindowRuntime,
  createWindowRuntime,
} from "../lib/window-runtime.mjs";

const calls = [];
const backend = {
  async tmux(args) {
    calls.push(args);
    const [cmd] = args;
    if (cmd === "list-windows" && args.includes("-a")) {
      return [
        "$1\twork\t2\t0\tcreated\t@1\t0\tcodex\t1\t1\t*\tcodex\t/dev/ttys001\t/repo\tnote one",
        "$1\twork\t2\t0\tcreated\t@2\t1\tshell\t0\t1\t-\tzsh\t/dev/ttys002\t/tmp\t",
      ].join("\n");
    }
    if (cmd === "list-panes") {
      return "%1\t0\t1\tcodex\t/repo\t100\t32\tcopy-mode\t123\tCodex pane";
    }
    if (cmd === "capture-pane") {
      return "hello screen\n";
    }
    if (cmd === "display-message" && args.at(-1) === "#{pane_mode}") {
      return "copy-mode\n";
    }
    if (cmd === "set-buffer" || cmd === "paste-buffer" || cmd === "send-keys") {
      return "";
    }
    throw new Error(`unexpected tmux call: ${args.join(" ")}`);
  },
};

const runtime = createTmuxWindowRuntime(backend);
assert.equal(runtime.kind, "tmux");
assert.equal(runtime.capabilities().model, "window-first");

const rmuxRuntime = createWindowRuntime({
  ...backend,
  muxKind: () => "rmux",
  muxCommand: () => "rmux",
});
assert.equal(rmuxRuntime.kind, "rmux");
assert.equal(rmuxRuntime.commandName(), "rmux");
assert.equal(rmuxRuntime.capabilities().runtime, "rmux");

const tree = await runtime.listTree();
assert.deepEqual(tree.sessions, [
  { id: "$1", name: "work", windows: 2, attached: false, created: "created" },
]);
assert.equal(tree.windows.length, 2);
assert.equal(tree.windows[0].id, "@1");
assert.equal(tree.windows[0].sessionId, "$1");
assert.equal(tree.windows[0].annotation, "note one");

const surfaces = await runtime.listWindowSurfaces({ windowId: "@1" });
assert.equal(surfaces.length, 1);
assert.equal(surfaces[0].id, "%1");
assert.equal(surfaces[0].surfaceId, "%1");
assert.equal(surfaces[0].kind, "tmux-pane");
assert.equal(surfaces[0].inCopyMode, true);

const captured = await runtime.captureSurface({
  surfaceId: "%1",
  mode: "screen",
  ansi: true,
});
assert.equal(captured, "hello screen\n");
assert.deepEqual(calls.at(-1), ["capture-pane", "-p", "-t", "%1", "-e"]);

await runtime.sendTextToSurface({
  surfaceId: "%1",
  text: "line\r\n\x1b[200~pasted\x1b[201~",
  enter: true,
});

const commandNames = calls.map((args) => args[0]);
assert.ok(commandNames.includes("display-message"), "exits copy mode check first");
assert.ok(commandNames.includes("set-buffer"), "uses tmux buffer paste");
assert.ok(commandNames.includes("paste-buffer"), "pastes the buffer");
assert.deepEqual(calls.at(-1), ["send-keys", "-t", "%1", "Enter"]);

console.log("window-runtime unit tests passed");
