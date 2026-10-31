---
name: tmax-multi-agent
description: Coordinate Codex, Claude Code and Pi workers through visible T-MAX sessions. Use for parallel development with a monitoring/integration coordinator, verified high-capability models, isolated worktrees, and history-preserving replacement when an agent runs out of quota or must change.
---

# Multi-Agent Work in T-MAX

The current agent is the coordinator: it plans, keeps monitoring and integrates;
it does not take an implementation stream for itself. Each delegated worker has
one named T-MAX session containing one named window on the target machine's
normal **tmux** server, visible in the user's
session list. The user can inspect or continue any worker directly, and workers
remain available when the coordinator disconnects. Use these sessions for the
delegated work rather than hidden, in-process subagents or headless CLI jobs,
unless the user explicitly chooses another mechanism.

Creating this Skill, explaining the workflow, or inspecting an existing team does
not authorize launching workers. Apply the execution steps when the user asks to
perform multi-agent work. Delegate only within that task's existing authorization;
release, spending and external-message limits also apply to every worker.

This workflow builds on the co-installed `tmax-start-agent`, `tmax-config-agent`
and `tmax-assign-task` Skills. Read their instructions for launch, model settings
and task delivery. Any of Codex, Claude Code or Pi can coordinate or work.

## Plan a small, visible team

Inspect the repository instructions, current Git state and existing T-MAX
sessions first. Establish the exact repository and target machine. Reuse an
existing team only after verifying its recorded identities and current work;
matching names alone do not authorize taking over a user's session.

Divide the requested outcome into independently verifiable work streams. Usually
start with two Codex workers unless the user chooses other runtimes or a different
team size; add Pi or Claude when requested or useful within the authorized plan.
There is no fixed two-worker limit: larger teams use the same session-per-worker
rules. An example of 100 workers is not a request to launch 100. Scale to useful
independent work, available machine capacity and the user's budget. Keep tightly
coupled changes together. Name one integration owner, usually the coordinator.
State the division briefly to the user and save the plan in the repository's
existing planning area. Use [the coordination template](references/coordination.md)
when there is no existing equivalent.

For each stream record: task, acceptance checks, owned paths, dependencies,
agent type, machine, session/window name, exact directory and branch. Honor the
user's agent choices. In a request to organize a team, the coordinator may choose
descriptive names and worktree paths inside the established project scope.
Use the default above when the user leaves the worker runtime unspecified;
check it is installed and authenticated on that machine. Ask only when access,
budget or the repository/machine remains materially ambiguous. Pass explicit values to
the startup Skill; do not make it infer them from a title.

## Isolate changes and shared resources

Use a separate Git worktree and branch for each worker that edits code. Check
for name/path collisions and local changes before creation; never reset, clean
or overwrite an existing checkout to make room. Record the shared baseline commit.
Read-only review workers may inspect an existing checkout without editing it.

Give shared interfaces/schema one owner. A worker needing another stream's files
should propose a small, separately identified change and record the dependency;
the coordinator reviews it with that owner before integration. Follow any existing
repository contract instead of inventing a second set of ownership rules.

Separate ports, test databases, queues, object-storage prefixes and temporary
outputs where those resources are used. Do not clone production data or duplicate
credentials for convenience. Keep credentials outside committed files and prompts.
For a shared single-tab Agent Browser, the coordinator owns browser verification;
workers use their scoped tests and request an acceptance check through their status
file. Do not let parallel workers navigate the same browser tab.

## Launch and hand off

Create each worker with `tmax-start-agent` in its prepared worktree. Preserve bare
interactive `claude`/`codex` launch commands and existing shell preferences. Verify
startup readiness, then record the actual machine, session, window and pane IDs.
Also record the agent's own conversation/session ID and readable history location
as soon as created; this ID is different from a tmux session ID or pane ID.
Never use an internal subagent ID as a substitute for a visible T-MAX session.

Before any implementation assignment, verify the worker's effective provider,
model and reasoning/thinking effort using `tmax-config-agent`. Unless the user
specifies otherwise, choose the highest-capability model available to that worker
and the highest effort that the selected model/runtime actually supports. Check
the current model menu/catalog and status, rather than assuming the shell's default
or a launch flag took effect. Record exact model ID, effort, verification time and
evidence; briefly report the choices to the user. This standing preference permits
the selection without asking for the same approval again.

Names such as o1 and levels such as extra-high/ultra are examples, not permanent
model pins or interchangeable settings. Resolve current capabilities every time;
never infer quality from a model's price or choose a cheap/mini/fast tier merely
because it starts successfully. If the intended model/effort is unavailable or
cannot be verified, mark the worker blocked and resolve the choice before assigning
implementation. Do not silently lower quality. Verify again after replacements,
resumes, provider changes, or observed automatic fallback. Respect explicit cost
and concurrency limits; this rule does not authorize purchasing credits.

Use `tmax-assign-task` to deliver one self-contained assignment to the verified
worker. Include the task/contract paths, owned files, dependencies, acceptance
checks, resource allocation and status-file path. Tell the worker to commit small
milestones on its branch, record commit IDs and test results, and leave integration
to the coordinator. Workers must not create further agents unless the user or
coordinator delegates that authority within the existing task; any further workers
must follow the same visible-session workflow and join the registry.

Confirm whether the handoff was submitted, queued or acknowledged. A paste or
successful API call alone is not acceptance. Do not duplicate an uncertain send.
Show the user the session names and assignments once the workers are ready.

## Monitor and coordinate

Keep a durable registry and per-stream status files. Track observed state
separately from delivery state: an idle terminal is not proof of completion.
Workers report the latest commit, completed milestone, tests, blockers and the
next dependency they need. The coordinator keeps watching and does integration
work while they run. Its code edits are limited to integration/conflict fixes and
shared contracts it owns; delegate feature implementation and substantial rework.

Monitor actual T-MAX window output, not just branch heads or session existence.
For a local worker, read its verified pane without sending input:

```sh
tmux capture-pane -p -J -t '%VERIFIED_PANE_ID' -S -100
```

For remote workers use the authorized T-MAX terminal reader or SSH on that exact
machine. Prefer progress notifications with periodic output checks; otherwise
inspect about every 30–60 seconds throughout the active task. Track working,
idle, needs-input, quota/rate-limit, authentication error, exited and unreachable
states from observed output. Inspect the relevant transcript when the tail is
ambiguous. For many workers, batch or rotate bounded tail reads, deduplicate
unchanged output, and record per-worker last-seen times; do not claim freshness for
workers not observed. Keep monitoring through integration until workers finish,
the user pauses/stops the task, or a reported blocker prevents continuation. Do not
install a permanent polling service or promise background monitoring that is not
running. Read the worker's status and relevant transcript after a change; a new
commit may only merge the baseline and need no new assignment.

Route dependency updates through the verified worker pane using the handoff Skill.
Preserve work in progress and unsent user text. If the user takes over a worker,
pause automatic assignments to it until ownership is clear. If a session vanishes,
inspect its branch/status/history before deciding how to resume; do not silently
create duplicate workers or send shell commands into an agent prompt.

On coordinator restart or context loss, reconstruct the team from the registry,
live session IDs, branch heads and status files. Reconcile differences before
sending anything. The visible workers continue to belong to the user.

## Replace a worker without losing its work

When quota is exhausted, the runtime fails, or the user requests a change, follow
[the replacement procedure](references/replacement.md). Preserve the original
agent conversation ID, history location/export, worktree and uncommitted work
before stopping it. Quiesce the original writer, start a replacement in a new
visible session/window, verify its model/effort, then tell it to read that original
history and reconcile the current code before continuing. Record the predecessor
and successor IDs. A new Claude conversation cannot natively resume a Codex ID;
the handoff transfers readable history and working state across runtimes.

## Integrate and finish

Review each delivered commit and its evidence. Merge approved work in dependency
order into the designated integration branch, resolving conflicts there. For
workers on other machines, transfer committed work through the authorized Git
remote before integration. Workers update from the integrated branch using the
repository's normal workflow; never rewrite another active worker's history.

Run the relevant checks on the combined result and the required end-to-end
acceptance checks. Passing per-worker tests does not prove integration works.
Record integrated commit IDs, verified behavior and unresolved items. Report
session names so the user can inspect every worker.

Stop only monitors created for this coordination task. Leave worker sessions,
branches and worktrees available for the user; do not delete them or terminate
agents as automatic cleanup. Ask before destructive removal when it is needed.
