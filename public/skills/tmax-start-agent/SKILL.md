---
name: tmax-start-agent
description: Start Claude Code, Codex or Pi in a new named T-MAX session and window at the user's chosen directory, handle startup trust prompts, and verify that the agent is ready for input. Use when the user asks to create or open a coding agent.
---

# Start an Agent in T-MAX

Create a new session containing one named window. Use T-MAX's **tmux** backend
only. Do not use Rmax/Rmux, create a separate tmux socket, or replace an existing
session. This Skill can be used by Codex, Claude Code or Pi; the agent being
started can be Claude Code, Codex or Pi.

## Establish the request

Require these three inputs before creating anything:

1. **Agent:** `claude`, `codex` or `pi`.
2. **Name:** session and window names. If the user gives one name, use it for both.
3. **Directory:** the exact working directory on the target machine.

Use clear values already supplied in the conversation. Ask one short question
for missing or ambiguous inputs; never guess a repository from a session title.
Use the current machine unless the user names another machine. If that target is
ambiguous, resolve it before proceeding. Resolve relative paths against the
explicitly established working directory on that machine, and check that the
directory exists. Do not create a directory or clone a repository implicitly.

## Create the shell

Run the bundled helper **on the target machine**, using the normal tmux server
that its T-MAX Connector observes:

```sh
python3 /absolute/path/to/tmax-start-agent/scripts/create-session.py \
  --agent claude --name 'review-api' --cwd '/absolute/project/path'
```

Use `--window-name` only for a different window name. The helper creates a
detached session with an interactive login shell, preserves the name, and
returns the session/window/pane IDs and the literal launch command. It does
**not** start the coding agent or claim readiness. If creation times out,
inspect the session list before retrying; never create a second session blindly.
If the name already exists, ask for a different name. Do not take over or kill it.

If working remotely, execute through an existing authorized SSH connection or
T-MAX terminal tools. Do not run the local helper and describe the result as a
remote session. With T-MAX MCP, use `create_terminal_session` with `mux: tmux`,
then `list_terminals` and `list_panes` to obtain exact IDs; rename its window
with `rename_window`. Validate the directory in that new shell before launching.
Do not use `create_agent_session` here: its generated launch flags may bypass
the user's shell aliases.

## Start the requested command

Read the new pane first. Wait for its shell to finish initialization; if a shell
setup dialog appears, resolve that specific blocker before sending commands.
Then send the helper's launch command **as literal text**, followed by Enter:

```sh
tmux capture-pane -p -t '%PANE_ID' -S -80
tmux send-keys -t '%PANE_ID' -l -- "cd -- '/absolute/project/path' && claude"
tmux send-keys -t '%PANE_ID' Enter
```

Substitute the actual pane ID and use proper shell quoting. Prefer argument
arrays in scripts; never interpolate untrusted paths into shell source. The
helper's `launchCommand` already quotes the directory. For Codex, the command
ends in `codex`; for Pi it ends in `pi`. Run the bare command in the interactive shell so the user's
existing aliases/functions apply. Do not use an absolute executable, `exec`, a
noninteractive shell, or add permission-bypass flags. Do not send the command
into an existing user pane.

With MCP, `send_prompt` sends the quoted `cd ... && claude` / `codex` / `pi` line to the
new pane; `read_terminal` and `send_key` handle the following steps. Always use
the exact machine/pane IDs and `mux: tmux`.

## Finish startup and verify readiness

Read the terminal after each action, at a modest interval (about 1–2 seconds).
Readiness means the requested agent's normal input prompt is visible, startup
dialogs are gone, and the process is still running in the requested directory.
A successful send, a running process, or a generic `>` alone is insufficient.

- **Trust this folder / project:** the user's request authorizes trusting the
  specified directory for this launch. Check that the displayed path matches;
  choose the affirmative option using its visible number or arrow keys and
  Enter. Read back the result. Do not blindly press Enter or assume an option
  number is identical across versions.
- **Other startup choices:** handle ordinary theme/onboarding choices using the
  existing preference or displayed default, then inspect the next screen.
- **Login, billing, missing executable, unexpected directory, or unrelated
  permissions:** do not treat these as folder trust. Report the precise blocker
  and obtain the missing input. Do not change account settings or install an
  agent implicitly.
- **Slow startup:** inspect progress without repeatedly sending launch commands.
  After about two minutes without reaching readiness, report the observed
  blocker and leave the new session available for inspection. Never claim it
  is ready while a dialog remains.

Pi's normal interactive startup is the bare `pi` command, not `--print`, JSON/RPC
mode or `--no-session`. Its model/provider readiness is separate from shell
readiness; an authentication or provider error is a blocker, not a ready worker.
For multi-agent work, follow `tmax-multi-agent`'s model/effort preflight after
startup and before assigning implementation work.

Check the final state twice briefly apart; use `tmux display-message` / process
inspection as needed to confirm the cwd and that the agent has not exited back
to a shell. Preserve the user-provided session/window names if the application
changes its terminal title. Do not submit a made-up task just to test readiness.
Once ready, stop polling and leave the session running. Report the machine,
agent, session/window names, exact directory and verified ready state. On failure,
report the existing target and blocker so a retry can resume without duplication.
