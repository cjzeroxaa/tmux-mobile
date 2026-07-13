# Add a machine to eng.impo.ai

This is the current connector setup for a Mac or Linux machine.

## What has to run

`https://eng.impo.ai` is the controller. Each machine runs one connector process:

```text
browser -> eng.impo.ai controller -> outbound WebSocket -> connector -> tmux/rmux
```

Running `tmux` by itself is not enough. The machine only appears after the
connector logs in and opens its outbound WebSocket. The connector does not need
an inbound port, Tailscale, or a local web server.

Command Center has two different concepts:

- A machine chip means the connector is online.
- Agent cards are recognized agent windows, not every tmux window on the box.
  A machine can be online and still have no cards if it has no recognized
  Claude/Codex/agent window.

## Prerequisites

- `git`
- Node.js `20+`
- `tmux` on `PATH`
- Optional: `rmux` on `PATH` if you want RMUX windows and web shares.

Current connectors auto-probe both `tmux` and `rmux` when no mux env var is set.
The service examples below still set `TMUX_MOBILE_MUXES=tmux,rmux` explicitly so
the intended runtimes are visible in the service config.

Use the Google account whose visibility you want:

- Google Workspace users see machines registered by users in the same hosted
  domain.
- Personal Google accounts see only their own machines.
- Super-admins configured on the controller see every machine.
- Per-machine special allowlists configured on the controller can grant a
  specific user access to a specific machine outside those rules.

## Fresh install

Use the controller's current connector branch:

```bash
export TMUX_MOBILE_REF=fix-connector-update-inventory
```

On a new machine:

```bash
mkdir -p ~/src
git clone --branch "$TMUX_MOBILE_REF" https://github.com/cjzeroxaa/tmux-mobile.git ~/src/tmux-mobile
cd ~/src/tmux-mobile
npm install --omit=dev

TMUX_MOBILE_MUXES=tmux,rmux node server.mjs --register https://eng.impo.ai --login
```

The first run prints a Google device-login URL and code. Approve it in a browser.
After approval the connector stores its token at:

```text
~/.config/tmux-mobile/agent.json
```

Future starts do not need `--login` unless you want to re-authenticate.

For an existing checkout:

```bash
cd ~/src/tmux-mobile
git fetch origin
git checkout "$TMUX_MOBILE_REF"
git pull --ff-only origin "$TMUX_MOBILE_REF"
npm install --omit=dev

TMUX_MOBILE_MUXES=tmux,rmux node server.mjs --register https://eng.impo.ai --login
```

## Keep it running

For a quick temporary run, put the connector in tmux:

```bash
tmux new-session -d -s tmux-mobile-connector \
  'cd ~/src/tmux-mobile && TMUX_MOBILE_MUXES=tmux,rmux node server.mjs --register https://eng.impo.ai'
```

For a real machine, use the OS user service below.

### macOS launchd

Create `~/Library/LaunchAgents/com.tmux-mobile.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.tmux-mobile.agent</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd /Users/YOUR-USER/src/tmux-mobile && exec node server.mjs --register https://eng.impo.ai</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>TMUX_MOBILE_MUXES</key>
    <string>tmux,rmux</string>
    <!-- Optional display name override:
    <key>AGENT_MACHINE</key>
    <string>my-mac</string>
    -->
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/YOUR-USER/Library/Logs/tmux-mobile-agent.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR-USER/Library/Logs/tmux-mobile-agent.log</string>
</dict>
</plist>
```

Replace `YOUR-USER`, then start it:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.tmux-mobile.agent.plist
launchctl print gui/$UID/com.tmux-mobile.agent | grep -E '(state|pid)'
tail -f ~/Library/Logs/tmux-mobile-agent.log
```

### Linux systemd user service

Two mistakes here make the agent silently fail to come back after a reboot.
Fix both up front:

1. **Use the real `node` path.** Many boxes have no `/usr/bin/node` (nvm, fnm,
   or a private install under `~/.local/node/bin`). Run `command -v node` and
   put that absolute path in `ExecStart`. A wrong path fails with
   `status=203/EXEC` and the service just flaps.
2. **Enable linger.** A `--user` service only runs while you have an active
   login session *unless* lingering is enabled. Without it the agent dies when
   your SSH session ends and never starts at boot — which looks exactly like
   "it doesn't reconnect after a reboot."

`~/.config/systemd/user/tmux-mobile-agent.service` (replace the node path; set
`AGENT_MACHINE` to the name you want in the picker):

```ini
[Unit]
Description=tmux-mobile connector -> eng.impo.ai
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=%h/src/tmux-mobile
Environment=TMUX_MOBILE_MUXES=tmux,rmux
# Use the output of `command -v node` — do NOT assume /usr/bin/node:
ExecStart=/home/YOUR-USER/.local/node/bin/node server.mjs --register https://eng.impo.ai
Environment=AGENT_MACHINE=YOUR-MACHINE-NAME
Restart=always
RestartSec=5
# Keep tmux/rmux sessions alive when the connector process restarts.
KillMode=process

[Install]
WantedBy=default.target
```

Start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now tmux-mobile-agent
sudo loginctl enable-linger "$USER"          # <- starts at boot, no login needed
journalctl --user -u tmux-mobile-agent -f    # watch for "event":"agent_registered"
```

Confirm it will actually survive a reboot:

```bash
loginctl show-user "$USER" -p Linger          # expect Linger=yes
systemctl --user is-enabled tmux-mobile-agent # expect enabled
```

> Why a `--user` service (not a system one): the update mechanism
> (`scripts/update-connector.mjs`) restarts the agent via
> `systemctl --user restart tmux-mobile-agent`. If no such *user* unit exists it
> falls back to a bare detached process that does **not** survive reboot. So the
> user unit above is what makes controller-pushed auto-updates and reboots both
> work.

## Verify

The agent prints a JSON line on every state change. A healthy registration
looks like:

```json
{"event":"agent_registered","controller":"https://eng.impo.ai",
 "websocket":"wss://eng.impo.ai/agent/connect",
 "machine":"<your-hostname>","auth":"device_token"}
```

If you see `agent_reconnecting` and an HTTP 403, your Google account isn't
on the allow list. If you see network errors, the controller might be
mid-deploy — retry in a minute.

## Machine name and identity

The display name comes from:

1. `AGENT_MACHINE`, if set
2. `os.hostname()`

The durable route identity is the connector's `agentId` in
`~/.config/tmux-mobile/agent.json`. Display names can change or collide; routing
uses the durable id.

To rename a machine, set `AGENT_MACHINE` in the launchd plist or systemd unit,
then restart the connector service. The saved token is tied to the Google
account, not the display name, so renaming does not require another login.

## Auto update

The connector advertises a `connectorVersion` and supported ops when it connects.
The controller compares that with the current required connector version. If the
machine is old, Command Center shows an update warning and an **Update connector**
button.

Clicking **Update connector** does this on the selected machine:

1. Opens a temporary mux session named `tmux-mobile-update-*` with a
   `connector-update` window.
2. Sends a small bash script into that window.
3. Downloads `scripts/update-connector.mjs` from the controller's configured
   update script URL.
4. Runs the update with environment supplied by the controller:
   - `TMUX_MOBILE_UPDATE_REPO`, normally `~/src/tmux-mobile`
   - `TMUX_MOBILE_UPDATE_CONTROLLER`, normally `https://eng.impo.ai`
   - `TMUX_MOBILE_UPDATE_REF`, currently `fix-connector-update-inventory`
   - `TMUX_MOBILE_UPDATE_EXPECTED_REVISION`, the controller's expected revision
   - optional `AGENT_MACHINE` / mux settings
5. The update script clones the repo if missing, fetches, checks out the target
   ref, `git pull --ff-only`s, verifies the expected revision, runs
   `npm install --omit=dev`, and syntax-checks the connector files.
6. It restarts the connector:
   - macOS: existing `launchd` service `com.tmux-mobile.agent`, if present
   - Linux: existing user systemd unit `tmux-mobile-agent.service`, if present
   - otherwise: starts a detached connector process and stops old connector pids

Update logs are written to:

```text
/tmp/tmux-mobile-connector-update.log
```

Detached fallback connector logs go to:

```text
/tmp/tmux-mobile-agent.log
```

If the connector is offline or too old to run the update, SSH into the machine
and rerun the fresh install/start commands manually.

## Quick checks

Controller health:

```bash
curl -fsS https://eng.impo.ai/api/health
```

Local connector process:

```bash
ps -axo pid,command | grep '[s]erver.mjs --register https://eng.impo.ai'
```

Mux availability:

```bash
tmux -V
rmux -V 2>/dev/null || true
```
