#!/bin/sh
# run-agent.sh — run the tmux-mobile agent under a minimal keepalive.
#
# WHY THIS EXISTS (and why it is NOT a "process manager"):
# The agent (`node server.mjs --register <controller>`) dials the controller over
# Socket.IO. Socket.IO already heals a live process's socket — a controller
# redeploy surfaces as a "transport close" and the agent auto-reconnects onto the
# new revision. What it CANNOT do is resurrect a DEAD process: an uncaught throw,
# an OOM kill, or an operator Ctrl-C leaves the agent gone, and the machine goes
# silently offline (the web UI hangs on "Waiting for <machine>"). On a long-lived
# host we want the agent to come straight back — with the SAME machine identity,
# or it re-registers under the bare hostname and orphans the user's recents.
#
# This is a 6-line relaunch loop, not launchd/systemd/pm2/Docker — it adds no
# daemon and nothing to enable at boot. It leans on the supervisor already
# running on the host (tmux, which owns the pane this loop runs in). The
# per-controller singleton lock in lib/connector-lock.mjs makes a double-start
# safe: a racing second process just fails to acquire the lock and this loop
# retries. For reboot survival, promote to a systemd --user unit instead.
#
# USAGE
#   scripts/run-agent.sh                       # uses the env below / defaults
#   AGENT_MACHINE=claw1 scripts/run-agent.sh   # pin the machine id (RECOMMENDED)
#
# ENV
#   TMUX_MOBILE_CONTROLLER  controller URL to register with
#                           (default: https://t.dev.sycamore.sh)
#   AGENT_MACHINE           machine id shown in the UI (default: hostname).
#                           PIN THIS on a host whose recents/bookmarks matter —
#                           an unset value re-registers under the bare hostname.
#   AGENT_RELAUNCH_DELAY    seconds to wait before relaunching (default: 3)
set -u

REPO_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
CONTROLLER="${TMUX_MOBILE_CONTROLLER:-https://t.dev.sycamore.sh}"
DELAY="${AGENT_RELAUNCH_DELAY:-3}"

cd "$REPO_DIR" || exit 1
echo "run-agent: repo=$REPO_DIR controller=$CONTROLLER machine=${AGENT_MACHINE:-（hostname）}"

while :; do
  # AGENT_MACHINE is exported (if set) so every relaunch keeps the same identity.
  node server.mjs --register "$CONTROLLER"
  code=$?
  echo "run-agent: agent exited (code=$code) — relaunching in ${DELAY}s $(date -u +%FT%TZ)"
  sleep "$DELAY"
done
