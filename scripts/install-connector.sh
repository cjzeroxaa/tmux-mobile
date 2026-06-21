#!/bin/sh
# tmux-mobile connector installer — clone-free. Joins this machine to the
# controller network by downloading the self-contained connector bundle and
# running it. No git checkout, no npm install. One-liner:
#
#   curl -fsSL https://eng.impo.ai/connector/install.sh | sh
#
# Name the machine (optional) and/or restart in the background instead of the
# foreground:
#
#   curl -fsSL https://eng.impo.ai/connector/install.sh | AGENT_MACHINE=my-box sh
#
# The controller origin is substituted in when this script is served; it also
# honors TMUX_MOBILE_CONTROLLER if you fetch the raw script.
set -eu

CONTROLLER="${TMUX_MOBILE_CONTROLLER:-__CONTROLLER__}"
DIR="${TMUX_MOBILE_DIR:-$HOME/.local/share/tmux-mobile}"
BUNDLE="$DIR/tmux-mobile-connector.mjs"
ENV_FILE="$DIR/connector.env"
LOG="$DIR/connector.log"
BUNDLE_URL="$CONTROLLER/connector/tmux-mobile-connector.mjs"

# --- locate Node (>= 20) ---------------------------------------------------
NODE="${TMUX_MOBILE_NODE:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE" ]; then
  echo "tmux-mobile: Node.js >= 20 is required but 'node' was not found in PATH." >&2
  echo "Install Node 20+ (https://nodejs.org) and re-run." >&2
  exit 1
fi
NODE_MAJOR=$("$NODE" -e 'process.stdout.write(String(process.versions.node.split(".")[0]||0))' 2>/dev/null || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 20 ] 2>/dev/null; then
  echo "tmux-mobile: Node.js >= 20 required (found $("$NODE" -v 2>/dev/null || echo none))." >&2
  exit 1
fi

# --- download the bundle (atomic) -----------------------------------------
mkdir -p "$DIR"
echo "tmux-mobile: downloading connector from $BUNDLE_URL"
TMP="$BUNDLE.tmp.$$"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$BUNDLE_URL" -o "$TMP"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP" "$BUNDLE_URL"
else
  echo "tmux-mobile: need curl or wget to download the connector." >&2
  exit 1
fi
mv -f "$TMP" "$BUNDLE"
echo "tmux-mobile: installed connector -> $BUNDLE"

# --- persist config so upgrades restart with the same identity -------------
{
  echo "TMUX_MOBILE_CONTROLLER=$CONTROLLER"
  [ -n "${AGENT_MACHINE:-}" ] && echo "AGENT_MACHINE=$AGENT_MACHINE"
} >"$ENV_FILE"

# --- stop any connector already running for this controller -----------------
PIDS=$(ps -axo pid=,command= 2>/dev/null | awk -v c="$CONTROLLER" \
  '/tmux-mobile-connector\.mjs|server\.mjs/ && /--register/ && index($0,c){print $1}' || true)
if [ -n "${PIDS:-}" ]; then
  echo "tmux-mobile: stopping existing connector ($PIDS)"
  # shellcheck disable=SC2086
  kill $PIDS 2>/dev/null || true
  sleep 1
  # shellcheck disable=SC2086
  kill -9 $PIDS 2>/dev/null || true
fi

# --- start ------------------------------------------------------------------
# Background restart (used by upgrades / re-installs once a token exists).
if [ "${TMUX_MOBILE_DETACH:-0}" = "1" ]; then
  echo "tmux-mobile: starting connector in the background (log: $LOG)"
  AGENT_MACHINE="${AGENT_MACHINE:-}" nohup "$NODE" "$BUNDLE" --register "$CONTROLLER" >>"$LOG" 2>&1 &
  echo "tmux-mobile: connector started (pid $!)."
  exit 0
fi

# First join: run in the foreground so the Google device-login URL is visible.
# (The connector auto-starts device login when no token is stored yet.)
echo "tmux-mobile: starting connector. On first run, open the Google login URL printed below."
echo "tmux-mobile: (to run it in the background instead, re-run with TMUX_MOBILE_DETACH=1)"
exec "$NODE" "$BUNDLE" --register "$CONTROLLER"
