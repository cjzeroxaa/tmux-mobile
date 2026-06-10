# Adding a machine to https://eng.impo.ai

Run this on any Mac (or Linux box) you want to drive from the phone. After
this is done you'll see the machine — and every one of its tmux sessions —
in the picker at https://eng.impo.ai.

## Prerequisites

- `tmux` installed and a `tmux` server running on the machine.
- `node >= 22`.
- A Google account whose email is in the controller's allow list:
  - `sonicgg@gmail.com`, or
  - anything ending in `@rebyte.ai`.
  - (Other accounts will be refused at device-login time. Ask the owner of
    eng.impo.ai to add yours.)

## One-time setup

```bash
# 1. Clone (or `git pull` if you already have it)
git clone https://github.com/cjzeroxaa/tmux-mobile ~/src/tmux-mobile
cd ~/src/tmux-mobile

# 2. Install deps
npm ci

# 3. Register this machine. --login triggers Google device-login.
node server.mjs --register https://eng.impo.ai --login
```

The CLI will print:

```
Open in a browser: https://www.google.com/device
Enter code: XXX-XXX-XXXX
Waiting for Google authorization...
```

On any device (phone is fine), open that URL, enter the code, sign in with
your allowed Google account, and click **Allow**.

The CLI will then print:

```
Google login complete: <your-email>.
Agent token saved: ~/.config/tmux-mobile/agent.json
event: agent_registered  websocket: wss://eng.impo.ai/agent/connect
```

That's it — open https://eng.impo.ai, sign in with the same account, and
your machine should appear in the picker.

## Keep it running

The `node server.mjs --register …` process needs to stay running. Options:

### A) tmux/screen — simplest, fine for a workstation

```bash
tmux new-session -d -s tmux-mobile-agent \
  'cd ~/src/tmux-mobile && node server.mjs --register https://eng.impo.ai'
```

(No `--login` on subsequent starts — it reuses the saved token in
`~/.config/tmux-mobile/agent.json`.)

`tmux attach -t tmux-mobile-agent` if you want to see the logs.

### B) launchd on macOS — survives reboots

Write `~/Library/LaunchAgents/com.tmux-mobile.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>           <string>com.tmux-mobile.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOUR-USER/.nvm/versions/node/v22.20.0/bin/node</string>
    <string>server.mjs</string>
    <string>--register</string>
    <string>https://eng.impo.ai</string>
  </array>
  <key>WorkingDirectory</key> <string>/Users/YOUR-USER/src/tmux-mobile</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key> <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>       <true/>
  <key>KeepAlive</key>       <true/>
  <key>StandardOutPath</key> <string>/Users/YOUR-USER/Library/Logs/tmux-mobile-agent.log</string>
  <key>StandardErrorPath</key> <string>/Users/YOUR-USER/Library/Logs/tmux-mobile-agent.log</string>
</dict>
</plist>
```

Replace `YOUR-USER` and the node path (`which node` to find it). Then:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.tmux-mobile.agent.plist
launchctl print gui/$UID/com.tmux-mobile.agent | grep -E '(state|pid)'
```

### C) systemd on Linux — survives reboots

`~/.config/systemd/user/tmux-mobile-agent.service`:

```ini
[Unit]
Description=tmux-mobile agent → eng.impo.ai

[Service]
WorkingDirectory=%h/src/tmux-mobile
ExecStart=/usr/bin/node server.mjs --register https://eng.impo.ai
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now tmux-mobile-agent
journalctl --user -u tmux-mobile-agent -f
```

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

## Renaming a machine

The agent picks its `machineId` at startup from, in order:

1. The `AGENT_MACHINE` env var, if set
2. `os.hostname()` as fallback

So your default name is whatever `hostname` prints (e.g. `homos-Mac-mini.local`).
To rename:

```bash
# stop the current agent
pkill -f -- '--register https://eng.impo.ai'

# restart with a custom name
AGENT_MACHINE="cj-mini" nohup node server.mjs --register https://eng.impo.ai \
  >/tmp/tmux-mobile-agent.log 2>&1 &
disown
```

That changes the name everyone sees in the picker. The saved token in
`~/.config/tmux-mobile/agent.json` is keyed by Google account, not machine
name, so no re-login.

To make the new name **persist across reboots**, set the env var in your
launchd plist / systemd unit:

- **launchd** — inside `<key>EnvironmentVariables</key>`:
  ```xml
  <key>AGENT_MACHINE</key>  <string>cj-mini</string>
  ```
- **systemd** — inside the `[Service]` block:
  ```ini
  Environment=AGENT_MACHINE=cj-mini
  ```

> ⚠ Renaming changes the **machineId**, which is what `?machineId=…` deep
> links and the per-machine RPC routing use. If anyone has bookmarked a
> URL into a specific window, those bookmarks will break. (No display-name
> overlay yet — both the picker label and the routing id are the same
> string.)

## Adding more machines

Run the same `--register --login` on each one. If you sign in with the
same Google account, all of them appear under your name. If a colleague
in the same Google Workspace (e.g. another `@rebyte.ai` user) does it
with their own account, their machines appear in your picker too — see
"Who can see what" below.

## Removing a machine

Either:

- Stop the agent process (`kill <pid>` / `launchctl bootout …`), and the
  controller marks it offline within ~1 s. It disappears from the picker.
- Or revoke the saved token: `rm ~/.config/tmux-mobile/agent.json` and stop
  the agent. The next `--register --login` issues a fresh token under
  whatever Google account you sign back in with.

## Who can see what

Visibility is tied to your Google account type:

- **Google Workspace** (`hd` claim present, e.g. `@rebyte.ai`) — see every
  machine registered by anyone in the same workspace.
- **Personal Google** (no `hd`, e.g. `@gmail.com`) — see only your own
  machines.
- **Super-admins** (deployment config, `SUPER_ADMIN_EMAILS`) — see every
  machine on the controller regardless of workspace.

Practical implication: register your machines with the Google account whose
workspace you want them visible inside. If you register a `@rebyte.ai`
machine while logged in as a personal Gmail account, only you will see it.

The controller runs your tmux commands by brokering them over the
WebSocket the agent opened **outbound** from your Mac. Nothing on your
Mac needs an inbound port; works behind NAT / VPN.
