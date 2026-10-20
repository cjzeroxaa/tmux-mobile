---
name: tmax-assign-task
description: Hand a user-authorized task to an existing agent in a specific T-Max window. Use when asked to assign, delegate, forward or hand off work to a named agent or window; clarify the task, verify the exact recipient, send once and check delivery.
---

# Assign a Task in T-Max

Deliver the user's task to the intended existing Claude Code, Codex or Pi agent.
The receiving agent owns the work. Do not start implementing the task yourself
just because its repository is available. Session creation belongs to
`tmax-start-agent`; operating model/settings/login menus belongs to
`tmax-config-agent`. Use T-Max's normal **tmux** backend, never Rmax/Rmux or a
separate tmux socket.

## Gather the task before sending

Recover relevant information from the current conversation and supplied files
first. Ask concise, specific questions for missing information that could change
the work. Bundle related questions rather than making the user repeat known facts.

Establish as needed:
- Intended result and what counts as done; for a bug, expected versus observed
  behavior and the steps that trigger it.
- Product/repository, platform and environment. A report about an iOS app does not
  identify which app. Inspect the supplied video/screenshot when it can resolve this.
- Evidence: original attachment paths, URLs, relevant frames/timestamps, logs and
  errors. Preserve exact paths, including spaces, and original user requirements.
- Scope and constraints, including whether implementation, investigation, release
  or only a review is authorized. Do not add deployment permission to a handoff.
- Work already done: commits, branch, uncommitted changes, test results, deployment
  state and unresolved limits. Clearly distinguish confirmed facts from hypotheses.

A short, clear request needs a short handoff. Do not demand a full questionnaire
or invent acceptance criteria the user did not request. When a material detail
remains unresolved, ask before submission rather than delegating a guess.

## Verify the recipient

Resolve the machine, session, window and pane. Names are discovery hints; exact
IDs identify the send target. Enumerate all panes, not just the active one:

```sh
tmux list-panes -a -F '#{session_id}\t#{session_name}\t#{window_id}\t#{window_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}'
```

For another machine, use authorized SSH or discover the T-Max terminal tool
schemas. Include its exact machine ID and `mux: tmux`. Do not infer that a remote
window is local, or send into a local same-name window as a substitute. Use the
available authorized inventory before declaring a named target absent.

Match the requested name (case differences can be harmless), then verify the
actual agent screen and process. Never use shared cwd, similar response content,
a fuzzy name match or the first search result as proof of identity. A window with
multiple panes still needs a specific recipient pane. Exclude your own pane.

- If the user has specified a unique window and the live inventory agrees, state
  the resolved machine/session/window and proceed; no repeated approval is needed.
- If multiple machines/windows match, the name differs, the pane is unclear, or
  the observed project conflicts with the request, show the candidates with their
  machine/session/window names and ask the user to choose. Do not send yet.
- If it is offline or absent, report that fact. Do not create, rename or replace an
  agent to make the assignment fit unless the user asks for that.

Capture the pane and record its machine, session/window/pane IDs and pane PID.
Confirm that the destination is the intended agent's input, not a shell, login
screen, trust prompt or model menu. Preserve unsent text and ongoing work. Wait
for an idle prompt, or use an observed non-interrupting queue if that agent
supports one; do not press Escape/Ctrl+C or restart it to force delivery. Ask when
continuing would interrupt a different task. Recheck identity and input state
immediately before pasting, and again after a user clarification or a long wait.

## Send a self-contained handoff once

Write in the user's language. Include enough context for a recipient that cannot
see this chat, with a clear task first. For example:

```text
The user assigned this task to <machine / session / window>:
<requested outcome and scope>

Observed / expected: <behavior and reproduction, when relevant>
Evidence: <original attachment paths, URLs and relevant timestamps>
Existing work: <commits, changed files, tests, actual deployment state>
Remaining work / constraints: <what the recipient should handle>
```

Verify that the recipient can access required attachments. A local path is not
usable on another machine by itself. Use an authorized private transfer or an
accessible existing reference; do not publish private evidence just to obtain a
link. If a required attachment cannot be delivered, explain the gap before sending.
Never include credentials or unrelated conversation history.

Send text literally, preserving newlines and characters. Separate paste from
submission; never interpolate the task as a shell command. For local tmux, load a
uniquely named buffer through stdin and paste with bracketed-paste support:

```sh
# TASK_FILE contains the exact handoff; substitute the verified pane ID.
# Use a unique buffer name owned by this operation.
tmux load-buffer -b HANDOFF_BUFFER - < TASK_FILE
tmux paste-buffer -d -p -b HANDOFF_BUFFER -t '%PANE_ID'
# Inspect the pane: it must show the handoff (possibly a collapsed paste preview).
# Recheck the destination, then submit in a separate tool call:
tmux send-keys -t '%PANE_ID' Enter
```

Use structured API tool arguments for remote text where possible. Read its schema
for submit/queue semantics; do not assume a successful paste also sent the prompt.
Remove only this operation's temporary buffer/file when finished.

## Verify and report delivery

Read the same pane after submission. Distinguish:
- **Pasted only:** text is still in the input; it has not been assigned yet.
- **Submitted or queued:** the prompt is in the transcript or an explicit queue.
- **Acknowledged:** the receiving agent says it has accepted/started the task.

Use a short bounded observation period. If the result is unclear, inspect before
retrying; do not submit the task twice because a response is slow. If identity
changed or a dialog consumed the input, stop and report what actually happened.
Do not claim acceptance merely from a successful send call. No need to wait for
the entire task to finish unless the user asked for monitoring.

Tell the user which machine/window received it and the observed delivery state.
After a handoff, leave implementation to the recipient unless the user explicitly
assigns separate work to you.
