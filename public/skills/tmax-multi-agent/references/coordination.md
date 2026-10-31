# Coordination record

Use the project's existing planning files when possible. The paths below are an
example, not a required repository layout. Keep this record free of credentials
and unrelated session transcripts.

## Team registry — for example `plan/team.md`

- Requested outcome and acceptance checks:
- Repository, target machine and baseline commit:
- Coordinator session and integration branch:
- Shared interface owner and integration order:
- Shared browser/resource owner:

| Stream | Task / owned paths | Agent | Machine / session / window / pane IDs | Worktree / branch | Dependencies | Observed state / timestamp |
| --- | --- | --- | --- | --- | --- | --- |
| API | Business routes and API tests | chosen runtime | fill after verified launch | absolute path / branch | shared schema | ready, handoff not yet sent |
| UI | Screens and component tests | chosen runtime | fill after verified launch | absolute path / branch | API contract | planned |

Record each stream's ports, database, queue and output prefix if used. Allocate
only resources the project needs. A smaller team may share a read-only contract;
a larger one needs explicit ownership of shared files.

## Worker handoff

```text
Implement <requested outcome> as the <stream> worker.
Read <repo instructions>, <team contract>, <task/status file> and <relevant spec>.
Work only in <absolute worktree>, branch <branch>. Own <paths>.
Shared interfaces belong to <owner>; record cross-stream proposals separately.
Use <allocated resources>. The coordinator handles shared browser acceptance.
Check <observable acceptance criteria and relevant tests>.
Commit milestones and update <status file> with commit, tests, blockers and next step.
Do not merge into the integration branch or start more agents without assignment.
The user may inspect or continue this T-MAX session directly.
```

## Worker status — for example `plan/lanes/<stream>.md`

- Task and owned paths:
- Baseline/integrated commit last received:
- Completed milestone and delivery commit:
- Tests actually run and results:
- Blocked by / requested interface change:
- Remaining acceptance checks:
- Next step / request to coordinator:

Record failures and unverified behavior explicitly. “Idle”, “committed” and
“accepted by the coordinator” are different states.
