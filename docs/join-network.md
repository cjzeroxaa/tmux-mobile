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

## Adding more machines

Run the same `--register --login` on each one and sign in with the SAME
Google account. Every machine appears under your name in the picker; one
account can own many machines.

If a different person at rebyte.ai sets up their own machine, they'll
sign in as themselves — their machines are in their slice, not yours.
Multi-user is per-Google-account, not per-org.

## Removing a machine

Either:

- Stop the agent process (`kill <pid>` / `launchctl bootout …`), and the
  controller will mark it offline. It stays in the list until you sign out
  and back in.
- Or revoke the saved token: `rm ~/.config/tmux-mobile/agent.json` and stop
  the agent. The next `--register --login` issues a fresh token.

## What gets shared

- **You** (the Google account that registered) can see and control every
  tmux session on the machine.
- **No other user** of eng.impo.ai can see your machine. The controller
  scopes the machine list to the logged-in user.
- The controller runs your tmux commands by brokering them over the
  WebSocket the agent opened *outbound* from your Mac. Nothing on your
  Mac needs an inbound port; if your Mac is behind NAT or a VPN it still
  works.
