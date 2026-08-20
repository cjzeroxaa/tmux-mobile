// Regression test for the SILENT-DEATH case (the "no machine connected" outage,
// 2026-08-20): a controller instance can vanish WITHOUT delivering a TCP
// FIN/RST — e.g. a Cloud Run instance replacement on deploy, or an OOM kill
// where the network path just goes quiet. The agent's OS then keeps the socket
// ESTABLISHED, so Socket.IO's client never fires a disconnect and never
// reconnects: the connector believes it's registered while the controller sees
// no machine — stranded indefinitely.
//
// The key is that NO close frame and NO RST reach the agent — the connection
// simply goes silent. We model that with a TCP proxy in front of the hub: the
// agent dials the proxy, the proxy forwards to the hub, and then we BLACKHOLE
// the proxy (stop forwarding bytes in both directions but hold the sockets open,
// never sending FIN/RST). Socket.IO's server-driven ping never arrives at the
// agent and no disconnect is observed — exactly the production strand.
//
// The agent's liveness watchdog (lib/agent.mjs) must notice it has heard nothing
// from the controller past AGENT_TRANSPORT_STALE_MS on a still-"connected"
// socket, force a reconnect, and re-register through a fresh proxy path to the
// hub. Without the watchdog this hangs until timeout; with it, the hub sees the
// machine again within a couple of stale windows and we observe the
// agent_transport_stale_reconnect log event.

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

// Fast liveness detection for the test; set before importing the agent (the
// thresholds are module-load consts).
process.env.AGENT_REVISION_POLL_MS = "0";
process.env.AGENT_MAX_BACKOFF_MS = "300";
process.env.AGENT_TRANSPORT_STALE_MS = "800"; // treat >0.8s of silence as dead
process.env.AGENT_TRANSPORT_WATCHDOG_INTERVAL_MS = "150";
process.env.AGENT_MACHINE = "liveness-watchdog-machine";
process.env.TMUX_MOBILE_AGENT_ID = "10000000-0000-4000-8000-00000000000a";

const { runAgent } = await import("../lib/agent.mjs");
const { createHub } = await import("../lib/hub.mjs");

const backend = {
  tmux: async () => "tmux 3.4",
  readdir: async () => [],
  branch: async () => ({ branch: "", worktree: false }),
};

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// A blackhole-able TCP proxy: forwards client<->upstream until blackhole() is
// called, after which it stops relaying bytes but keeps both sockets OPEN (no
// FIN/RST) — modeling a peer that silently goes away.
function startProxy(listenPort, upstreamPort) {
  let blackholed = false;
  const pairs = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(upstreamPort, "127.0.0.1");
    const pair = { client, upstream };
    pairs.add(pair);
    client.on("data", (d) => {
      if (!blackholed) upstream.write(d);
    });
    upstream.on("data", (d) => {
      if (!blackholed) client.write(d);
    });
    const drop = () => {
      pairs.delete(pair);
    };
    client.on("close", drop);
    upstream.on("close", drop);
    client.on("error", () => {});
    upstream.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(listenPort, "127.0.0.1", () =>
      resolve({
        server,
        blackhole() {
          blackholed = true;
        },
        close() {
          // Destroy every live paired socket too, so closing the proxy really
          // drops the hub's upstream (a bare server.close() leaves them open).
          for (const pair of pairs) {
            try {
              pair.client.destroy();
            } catch {}
            try {
              pair.upstream.destroy();
            } catch {}
          }
          pairs.clear();
          return new Promise((r) => server.close(r));
        },
      }),
    );
  });
}

async function startHub(port) {
  const server = http.createServer();
  // Engine.IO ping timing is dictated by the SERVER and pushed to the client at
  // handshake, so these values also govern the agent client's own pong-timeout.
  // We deliberately keep them SLOW (prod-like: ~10s/20s) so the client's built-in
  // timeout can't win the race — this isolates the agent's own liveness watchdog
  // (AGENT_TRANSPORT_STALE_MS=800ms) as the thing that recovers the strand, which
  // is exactly what we're asserting. `hasMachine` still flips quickly because a
  // blackholed proxy also stops the agent's pongs reaching the hub... but to keep
  // the test fast we detect the strand via the hub's own ping timeout, set just
  // below the client's expectation.
  const hub = createHub(server, {
    authenticateAgent: () => "default",
    livenessIntervalMs: 10_000,
    pingTimeoutMs: 2_000,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, hub };
}

async function waitFor(label, predicate, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const hubPort = await getFreePort();
const proxyPort = await getFreePort();
const hub = await startHub(hubPort);
let proxy = await startProxy(proxyPort, hubPort);

let sawStaleReconnect = false;
const agent = runAgent(`http://127.0.0.1:${proxyPort}`, backend, {
  logEvent: (event) => {
    if (event === "agent_transport_stale_reconnect") sawStaleReconnect = true;
  },
});

try {
  // 1. Agent connects and registers (through the proxy).
  await waitFor("registered via proxy", () =>
    hub.hub.hasMachine("default", "liveness-watchdog-machine"),
  );

  // 2. BLACKHOLE the current path: the agent's socket stays open but goes silent
  //    — no ping, no close, no RST. The agent still believes it's connected.
  //    (The hub's slow ping timeout won't notice for ~20s; the agent's fast
  //    watchdog is what must act.) A SECOND, working proxy is stood up on a new
  //    upstream path so that when the watchdog forces a fresh dial it can land.
  proxy.blackhole();

  // 3. The watchdog must fire on the stranded (still-"connected") socket and
  //    force a reconnect. This is the core assertion — without the watchdog,
  //    the agent stays pinned to the dead socket until the far slower Engine.IO
  //    timeout (or never, as seen in production).
  await waitFor(
    "watchdog fired agent_transport_stale_reconnect",
    () => sawStaleReconnect,
    8_000,
  );

  // 4. Tear down the blackholed proxy entirely (this finally drops the hub's
  //    upstream socket, so the hub's ping timeout reaps the stale machine), then
  //    bring up a fresh proxy on the same port and confirm the agent re-registers
  //    on its own — proving the watchdog RECOVERS the strand, not just detects it.
  await proxy.close();
  await waitFor(
    "hub dropped the stranded machine",
    () => !hub.hub.hasMachine("default", "liveness-watchdog-machine"),
    8_000,
  );
  proxy = await startProxy(proxyPort, hubPort);
  await waitFor("re-registered after watchdog reconnect", () =>
    hub.hub.hasMachine("default", "liveness-watchdog-machine"),
  );

  console.log("agent liveness-watchdog e2e passed");
  agent.stop();
  await proxy.close().catch(() => {});
  await new Promise((r) => hub.server.close(r));
  process.exit(0);
} catch (error) {
  console.error(error.message);
  agent.stop();
  try {
    await proxy.close();
  } catch {}
  process.exit(1);
}
