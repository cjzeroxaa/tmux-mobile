---
name: tmax-multi-agent
description: Coordinate parallel coding agents through visible, persistent T-MAX sessions. Use when the user asks for multi-agent development, parallel work streams, or a team of agents whose progress they can inspect and take over. Covers task division, isolated worktrees, handoffs, monitoring and integration.
---

# Multi-Agent Work in T-MAX

The current agent is the coordinator. Each delegated worker is a named T-MAX
session on the target machine's normal **tmux** server, visible in the user's
session list. The user can inspect or continue any worker directly, and workers
remain available when the coordinator disconnects. Use these sessions for the
delegated work rather than hidden, in-process subagents or headless CLI jobs,
unless the user explicitly chooses another mechanism.

Creating this Skill, explaining the workflow, or inspecting an existing team does
not authorize launching workers. Apply the execution steps when the user asks to
perform multi-agent work. Delegate only within that task's existing authorization;
release, spending and external-message limits also apply to every worker.

This workflow builds on the co-installed `tmax-start-agent` and
`tmax-assign-task` Skills. Read their `SKILL.md` files before creating sessions or
sending assignments. They provide the actual launch and delivery procedures;
this Skill provides team coordination. Codex, Claude Code or Pi can coordinate;
the startup Skill currently launches Claude Code and Codex workers. Do not invent
a Pi startup procedure or claim that a missing dependency is installed.

## Plan a small, visible team

Inspect the repository instructions, current Git state and existing T-MAX
sessions first. Establish the exact repository and target machine. Reuse an
existing team only after verifying its recorded identities and current work;
matching names alone do not authorize taking over a user's session.

Divide the requested outcome into independently verifiable work streams. Choose
only as many workers as useful work and available resources justify. Keep tightly
coupled changes together. Name one integration owner, usually the coordinator.
State the division briefly to the user and save the plan in the repository's
existing planning area. Use [the coordination template](references/coordination.md)
when there is no existing equivalent.

For each stream record: task, acceptance checks, owned paths, dependencies,
agent type, machine, session/window name, exact directory and branch. Honor the
user's agent choices. In a request to organize a team, the coordinator may choose
descriptive names and worktree paths inside the established project scope.
Resolve the agent type from the user's preference or the current coordinator
runtime if it is supported and installed; ask only when that choice or the
repository/machine remains materially ambiguous. Pass these explicit values to
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
Never use an internal subagent ID as a substitute for a visible T-MAX session.

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
next dependency they need. The coordinator can do independent integration work
while the workers run; do not implement a worker's owned changes concurrently.

Prefer available progress notifications or a task-scoped monitor of branch heads
and session existence. Otherwise inspect at a modest interval, about 30–60
seconds while actively coordinating, and stop when no longer needed. Do not
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
