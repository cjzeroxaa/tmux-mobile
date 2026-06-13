# Claude Code and Codex notification hooks

This is the minimal setup I use for phone notifications when an agent turn
finishes. The important parts are:

- Hook at the agent's stop/notification event, not inside tmux-mobile.
- Let the hook command receive the full JSON payload. Do not reduce it to only a
  message string in the config.
- Add the tmux-mobile URL before sending the notification.

## Topic

The ntfy topic is local policy. Pick one per user/device instead of sharing a
global topic. A simple convention is:

```bash
export NTFY_TOPIC="meowoof-your-suffix"
```

For example: `meowoof-alice`, `meowoof-mini`, or `meowoof-prod`. Keep the
`meowoof-` prefix and let each user choose the suffix.

## Claude Code

Hook file: `~/.claude/settings.json`.

Hook event: `Stop`.

My setting shape:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/hooks/notify-summary.sh"
          }
        ]
      }
    ]
  }
}
```

Claude Code sends the Stop hook JSON on stdin. The useful fields include `cwd`,
`transcript_path`, and `last_assistant_message`, but the hook should keep the
whole payload available because fields change across versions.

## Codex

Codex should point to the same hook script. In `~/.codex/config.toml`:

```toml
notify = ["/Users/YOU/.claude/hooks/notify-summary.sh"]

# Optional on a single-user trusted machine, so Codex does not ask about the
# hook file every time it is loaded.
bypass_hook_trust = true
```

When you want the full stop-event payload too, also add
`~/.codex/hooks/hooks.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/YOU/.claude/hooks/notify-summary.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Codex payloads can expose the final response as `last-assistant-message`.
Depending on the Codex surface, transcript lookup may require falling back to
Codex's local session state. Do not assume the Claude `transcript_path` field
exists.

## Hook script contract

The hook script should accept both stdin and argv payloads:

```bash
if [[ $# -gt 0 && -n "${1:-}" ]]; then
  PAYLOAD="$1"
else
  PAYLOAD="$(cat)"
fi
```

If forwarding to another service, send the full `PAYLOAD` as-is and add derived
fields such as `agent`, `machine`, and `app_url`. For a plain ntfy push, it is
fine to make the visible notification body short, but keep the full payload in
logs or in the webhook POST.

Minimum fields to derive:

- `cwd`: project label and tmux pane matching.
- `last_assistant_message` or `last-assistant-message`: notification body.
- `transcript_path`: Claude transcript fallback.
- `thread-id`, `session_id`, or `thread_id`: Codex transcript fallback.

## URL

Set an app URL that already points at the tmux-mobile app page:

```bash
export TMUX_MOBILE_APP_URL="https://eng.impo.ai/app/"
```

Then append whatever targeting data you can find:

- `machineId`: the tmux-mobile machine id.
- `session`: tmux session name.
- `window`: tmux window index.
- `windowName`: tmux window name.

Final links should look like:

```text
https://eng.impo.ai/app/?machineId=mini&session=work&window=2&windowName=Codex+Task
```

The hook should include that URL in the ntfy body, for example:

```text
Open: https://eng.impo.ai/app/?machineId=mini&session=work&window=2
```
