---
name: tmax-config-agent
description: Configure or sign in to an existing Claude Code, Codex or Pi agent through its T-Max terminal window. Use when asked to change an agent's model, settings or interactive mode, complete login, or operate an agent-specific menu. For a new agent, use tmax-start-agent first.
---

# Configure an Agent in T-Max

Operate the existing agent's terminal UI to reach the user's requested state.
Use T-Max's **tmux** backend only, on the target machine's normal tmux server.
Do not create an Rmax/Rmux session or a separate socket. This Skill works when
invoked by Claude Code, Codex or Pi and can operate any of those three agents.

## Locate and inspect the target

Resolve the machine, session/window and requested change from the conversation.
Names are useful for discovery; use exact machine/session/window/pane IDs for
all actions. If several windows match, present the candidates and ask which
one. Do not pick the first result, infer identity from a shared cwd or last
response, or merge windows because they display the same conversation text.

Locally, list the current T-Max terminals with:

```sh
tmux list-panes -a -F '#{session_id}\t#{session_name}\t#{window_id}\t#{window_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}'
```

On another machine, run through authorized SSH or use the available T-Max
terminal tools. With MCP, discover the current schemas and use `list_terminals`,
`list_panes` and `read_terminal`, then `send_prompt` / `send_key` as appropriate;
include the exact machine ID and `mux: tmux`. Do not assume the local machine is
the remote one. If a tool cannot send text without submitting it, prefer the
normal tmux connection for menu input.

Record the IDs and pane PID. Read the pane, inspect its process tree if needed,
and identify the running agent from the actual UI/process. A renamed window or
`node`/a version number in `pane_current_command` is not an agent identification.
Confirm it is that agent's prompt or a relevant dialog, not a shell. Recheck the
target before each mutation and after any pause for user input. If the process
or pane changed, inspect the new state rather than replaying old keystrokes.

Preserve a user's unsent input and running work. Do not blindly clear input,
press Escape/Ctrl+C, restart, log out or kill an agent to make the UI convenient.
Wait for an idle prompt when needed. If continuing would interrupt work or alter
an unrelated setting, ask for that specific decision. No need to reconfirm the
configuration change the user already requested.

## Observe → act → verify

Discover the installed agent's commands from its current menu/help or official
documentation when uncertain. Commands, menu ordering and available models vary
by version/account. Do not maintain or assume an exhaustive command catalog.
Useful official starting points:

- [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode)
- [Codex CLI commands](https://developers.openai.com/codex/cli/slash-commands) and
  [authentication](https://developers.openai.com/codex/auth)
- [Pi's current usage guide](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)

Use a separate read after each meaningful action. For example, after confirming
that the target is idle and `/model` is supported:

```sh
tmux capture-pane -p -J -t '%PANE_ID' -S -120
tmux send-keys -t '%PANE_ID' -l -- '/model'
# Let the editor accept the text, then submit in a separate call.
tmux send-keys -t '%PANE_ID' Enter
tmux capture-pane -p -J -t '%PANE_ID' -S -120
```

Replace placeholders with the resolved IDs. `-l` sends literal text; omit it for
keys such as `Up`, `Down`, `Left`, `Right`, `Tab`, `Enter`, `Escape`. Never send a
whole blind sequence of arrows and Enter. Inspect the visible selection, move,
inspect again, then confirm. A successful send only proves input was delivered.
Use short waits (typically 1–2 seconds) for redraws; if a screen stops changing,
inspect the blocker instead of repeating commands indefinitely.

For model changes, match the requested provider/model and any requested effort
level to actual options. Do not silently substitute a similarly named model.
Confirm the final model/setting from the status line, settings screen or a
read-only status command. Distinguish session-only settings from account/global
defaults; use the scope the user requested. If the UI exposes only a broader
scope, explain it before changing that scope. For example, a Claude menu may label
Enter as changing the default and `s` as session-only; follow the current labels.
Leave the normal input prompt
ready and stop polling. Do not submit a fabricated task to prove the setting.

## Interactive login

An unauthenticated agent is a separate state, not a folder-trust prompt.
For a login request, use the agent's supported login flow (`/login` where the
current UI supports it). If authentication requires a shell command, do not type
it into the agent prompt or exit a working conversation implicitly; establish a
safe shell target and preserve the original session.

1. Read the actual login screen and requested provider/account. Keep the same
   login process and target alive throughout the handoff.
2. Give the user the **complete original authorization URL**, with every query
   parameter and fragment unchanged, in a copyable code block. Do not shorten,
   decode/re-encode, replace a localhost URL with a guessed public one, or browse
   a one-time authorization link yourself. `capture-pane -J` joins soft wraps.
   If the screen truncates the URL, obtain the agent's full text/copy output;
   never reconstruct missing characters. Exclude the URL from durable reports.
3. Explain what this particular flow expects. A paste-back flow needs the code
   or callback the CLI explicitly requests. A device-code flow may instead ask
   the user to enter a displayed code in their browser and then complete by
   polling; a browser-callback flow may complete automatically. Follow the
   observed flow rather than requiring a paste-back code for every provider.
4. Wait for the user. Keep a non-secret continuation note with machine, IDs,
   agent and current step so the next turn resumes the same flow. Do not start
   a second login or repeatedly refresh the URL while waiting. Do not ask for
   a password, access token or credential file.
5. When the user provides the required code, first reread the same target to
   confirm it is still waiting for that code. Send it as literal input to that
   field, then Enter separately. Avoid logging/echoing it or saving it in files,
   command history or reports. A tmux buffer loaded via stdin and pasted with
   deletion (`load-buffer -b <unique-name> -`, `paste-buffer -d -p`) can transfer
   text without placing it in a shell command; clean up only that owned buffer
   if a paste fails. Never send a code to a shell or ordinary chat prompt.
6. Verify the agent's explicit success/account status and return to its ready
   prompt. If it expired or failed, report the precise error and obtain a fresh
   URL/code through that same supported flow. Do not claim login succeeded merely
   because the URL opened or a code was submitted.

Report the target, observed final setting/login state and any remaining blocker.
Keep auth codes and credentials out of the result. Preserve the session/window
names and the user's conversation. Session creation belongs to `tmax-start-agent`;
configuration here continues in the window that Skill created.
