import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  localBackend,
  normalizeRmuxWebShareFrontendUrl,
  parseRmuxWebShareList,
  parseRmuxWebShareOutput,
} from "../lib/backend.mjs";

const parsed = parseRmuxWebShareOutput(
  "share expires at 2026-06-19T00:07:57+00:00\noperator pin 113518\n",
  "rmux: operator URL (keep private):\nrmux:   https://share.rmux.io/#e=wss://df218d15de5adb.lhr.life/share&t=abc123\ntunnel provider localhost-run\ntunnel url https://df218d15de5adb.lhr.life\noperator URL emitted on stderr\n",
);

assert.equal(
  parsed.operatorUrl,
  "https://share.rmux.io/#e=wss://df218d15de5adb.lhr.life/share&t=abc123",
);
assert.equal(parsed.code, "113518");
assert.equal(parsed.expiresAt, "2026-06-19T00:07:57+00:00");
assert.equal(parsed.tunnelProvider, "localhost-run");
assert.equal(parsed.tunnelUrl, "https://df218d15de5adb.lhr.life");

assert.deepEqual(parseRmuxWebShareList("qxa5zh54 impo:%4 -\n"), [
  { id: "qxa5zh54", target: "impo:%4", expiresAt: "" },
]);

assert.equal(normalizeRmuxWebShareFrontendUrl(""), "");
assert.equal(
  normalizeRmuxWebShareFrontendUrl("https://rmux-share.pages.dev/#t=secret"),
  "https://rmux-share.pages.dev",
);
assert.equal(
  normalizeRmuxWebShareFrontendUrl("https://example.com/share/?x=1"),
  "https://example.com/share",
);
assert.throws(
  () => normalizeRmuxWebShareFrontendUrl("notaurl"),
  /Invalid RMUX web share frontend URL/,
);

const tmp = await mkdtemp(path.join(os.tmpdir(), "tmux-mobile-rmux-share-"));
const fakeRmux = path.join(tmp, "rmux");
const argsLog = path.join(tmp, "args.log");
const previousRmuxCommand = process.env.TMUX_MOBILE_RMUX_COMMAND;
try {
  await writeFile(
    fakeRmux,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$RMUX_ARGS_LOG"
if [ "$1" = "web-share" ] && [ "$2" = "list" ]; then
  printf 'newshare impo:%%321 -\\n'
  exit 0
fi
printf 'rmux: operator URL (keep private):\\nrmux:   https://rmux-share.pages.dev/#e=wss://terminal.example/share&t=tok\\n' >&2
printf 'operator pin 123456\\n'
`,
  );
  await chmod(fakeRmux, 0o755);
  process.env.TMUX_MOBILE_RMUX_COMMAND = fakeRmux;
  process.env.RMUX_ARGS_LOG = argsLog;
  const shared = await localBackend.rmuxWebShare({
    target: "%321",
    ttlSeconds: 60,
    tunnelProvider: "localhost-run",
    frontendUrl: "https://rmux-share.pages.dev/path/?ignored=1#secret",
  });
  assert.equal(
    shared.operatorUrl,
    "https://rmux-share.pages.dev/#e=wss://terminal.example/share&t=tok",
  );
  assert.match(
    await readFile(argsLog, "utf8"),
    /web-share -t %321 --operator-only --ttl 60 --tunnel-provider localhost-run --frontend-url https:\/\/rmux-share\.pages\.dev\/path/,
  );
} finally {
  if (previousRmuxCommand === undefined) {
    delete process.env.TMUX_MOBILE_RMUX_COMMAND;
  } else {
    process.env.TMUX_MOBILE_RMUX_COMMAND = previousRmuxCommand;
  }
  delete process.env.RMUX_ARGS_LOG;
  await rm(tmp, { recursive: true, force: true });
}

console.log("rmux-web-share unit tests passed");
