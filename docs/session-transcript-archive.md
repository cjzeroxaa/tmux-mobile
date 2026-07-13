# Session Transcript Archive

Status: implementation in progress, based on the transcript readers already in
this repository and aggregate inspection of local Claude Code and Codex
transcripts. The first slice implements acknowledged raw chunks over the
existing authenticated connector protocol, object-store manifests with linked
immutable range records, and pure central decoder state machines. SQS delivery
and production rollout remain future slices.

### Implemented-slice boundary (2026-07-12)

The rules below describe the target architecture. The code currently lands a
deliberately disabled raw-archive slice with these narrower guarantees:

- the controller capability is off by default, requires an explicit machine
  canary allowlist, and probes object-store write/read before advertising it;
- connectors only learn the capability after authenticated `HELLO`, persist an
  exact pending newline-aligned chunk before upload, and move their local byte
  cursor only after the controller's durable ACK;
- connector/controller share a 16 MiB raw-chunk ceiling. An over-limit JSONL
  record is quarantined locally without network retry; if a remote cursor reset
  races file rotation, the old unacknowledged pending bytes are retained and
  quarantined rather than discarded;
- the controller validates hashes, byte/line continuity, epoch chain, retries,
  and serializes manifest writes inside one process;
- discovery always covers sessions observed in normal active inventory. An
  independently gated recursive scanner can also find UUID-named regular
  `.jsonl` files under the allowlisted Claude/Codex roots (including closed
  sessions), without following symlinks or parsing vendor JSON. Both paths
  start a newly observed raw archive at offset zero;
- the central decoder module is shadow/test-only. It is not connected to the
  archive, a durable decoder checkpoint, outbox, SQS, or Event Radio;
- S3 ETag/GCS generation preconditions prevent overlapping controller tasks
  from rolling a manifest backward. Immutable range metadata links backward
  from the manifest so a known epoch can be replayed with object `get` calls;
  a durable owner/machine/source catalog and decoder checkpoint still do not
  exist, so this must not be presented as production event delivery;
- live watermarks and an initial publication fence are not implemented. No
  archived historical completion may be published as a new live event, and a
  Claude `end_turn` must never be settled merely because a chunk reached EOF.

In other words, this slice proves resumable raw-byte transport. It does not yet
claim complete discovery, central event production, or “Event 不丢失”.

## Decision

The machine connector will replicate agent transcript bytes to the controller.
It will not interpret Claude Code or Codex records and it will not install a
local Stop hook. The controller will durably archive the byte stream, assign
stable physical-line coordinates, and run versioned Claude/Codex decoders.

This separation is deliberate:

- the connector owns file discovery, byte ranges, retry, and backpressure;
- the connector assigns provisional physical line coordinates while framing;
- the archive validates durable ordering, ACKs, epochs, and replay;
- decoders own vendor-specific schemas and completion semantics;
- an outbox owns delivery to SQS and other consumers.

An assistant text record is not, by itself, a completion event. A transcript is
an append-oriented log of model messages, tool calls, tool results, metadata,
interruptions, and lifecycle markers.

## Goals

- Preserve every observed transcript byte across connector and controller
  restarts.
- Resume from an acknowledged byte without resending an entire file.
- Give every physical JSONL line a stable coordinate even though neither
  vendor provides a numeric line sequence.
- Decode centrally so schema fixes can be replayed without updating every
  connector.
- Produce idempotent normalized events for Event Radio, dashboards, and other
  consumers.
- Distinguish completed, waiting, cancelled, failed, and still-running work.
- Keep raw transcripts private and short-lived by policy.

## Non-goals

- Exactly-once delivery over the network. Transport is at-least-once; storage
  and consumers are idempotent.
- Editing, compacting, or repairing local transcript files.
- Treating file EOF, mtime, an assistant message, or `end_turn` alone as proof
  that a CLI turn completed.
- Parsing transcript content on each machine.
- Installing or depending on Claude Code/Codex notification hooks.

## High-level flow

```text
Claude Code / Codex
        |
        | append JSONL
        v
local transcript file
        |
        | raw byte ranges over the existing outbound connector channel
        v
controller ingest -> raw object archive -> central decoder -> event outbox -> SQS
                           |                    |
                           |                    +-> completion / waiting / failure
                           +-> replay on decoder upgrades
```

The browser is not in this path. Closing every tmux-mobile tab must not stop
archive replication or event production.

## Entities and identity

### Machine

`machineAgentId` is the durable connector identity already registered with the
controller. Display hostnames and aliases are labels, not routing or dedup keys.
Every archive object is also scoped by the authenticated owner/tenant.

```text
MachineKey = (ownerId, machineAgentId)
```

### Source file

A source is one locally discovered transcript path. The raw path is needed only
on the machine. The connector sends a random `sourceId` and a keyed
`pathFingerprint` (HMAC with a machine-local secret); it must not put project
paths in logs, metrics, object keys, or user-visible errors.

```text
SourceKey = (MachineKey, sourceId)
```

`agentKind` is `claude`, `codex`, or `unknown`, derived only from the allowlisted
transcript root. It helps route a decoder but is not authoritative schema
evidence.

### File epoch

A path is not a permanent file identity. A file can be truncated, replaced,
rotated, restored, or recreated with an inode that was later reused. Each
continuous generation therefore has a connector-generated random `fileEpoch`.

The connector keeps the same epoch while file identity and size are monotonic.
It starts a new epoch when any of these is observed:

- device/inode or another platform file identity changes;
- size becomes smaller than the acknowledged or observed offset;
- a stored prefix fingerprint conflicts;
- a previously deleted source path reappears and continuity cannot be proven;
- local replication state is lost and the old generation cannot be recovered
  unambiguously.

Starting a new epoch is safe even when conservative: it may cause semantic
replay, but it never aliases new bytes onto old byte coordinates. Central event
dedup handles the replay.

```text
FileKey = (SourceKey, fileEpoch)
```

### Session

File identity and agent-session identity are separate. The central decoder
extracts and validates session identity from supported records and, where
necessary, the vendor path convention supplied as a non-sensitive hint.

```text
SessionKey = (MachineKey, agentKind, vendorSessionId)
```

For Claude Code, the session ID is normally the UUID represented by the
transcript filename and record `sessionId`. For Codex, the decoder prefers the
supported session metadata record and falls back to a validated UUID hint from
the rollout path. Conflicts are quarantined rather than guessed.

If a session ID is unavailable, the decoder may create a provisional identity
using `FileKey`, but events from it are not published until policy explicitly
allows provisional sessions.

### Raw line and semantic record

`rawLineSeq` is a zero-based physical JSONL line number assigned by the central
archive within one `fileEpoch`. It is not a vendor field and it is not a
conversation-turn number.

```text
RawLineKey = (FileKey, rawLineSeq)
RawLineRange = [byteStart, byteEnd)  // includes the terminating newline
```

A semantic record ID is decoder-owned:

- use a validated vendor record UUID when present;
- otherwise use `RawLineKey`;
- never use assistant text or timestamp alone.

Repeated identical assistant answers are distinct events when their source
records are distinct.

## Connector: pure byte replication

The connector discovers only allowlisted roots, initially:

- `~/.claude/projects/**/*.jsonl`
- `~/.codex/sessions/**/*.jsonl`

It opens files read-only, stats them, and copies byte ranges. It may count
newline bytes and compute hashes, but it must not JSON-parse records, inspect
roles, detect completions, extract text, or run vendor-specific commands.

The connector maintains a small durable replication manifest containing only:

- `sourceId`, encrypted/local source path, and `pathFingerprint`;
- file identity and `fileEpoch`;
- controller-acknowledged byte offset and next raw line sequence;
- pending chunk metadata and retry state.

When offline, the original transcript remains the primary spool. Bytes that may
disappear before reconnection must be copied into a bounded local raw-byte spool.
Disk pressure must raise a visible error and stop advancing the cursor; it must
never silently skip bytes.

V1 chunks end on a JSONL newline. Finding the last newline and counting newline
bytes is byte framing, not vendor decoding, so the connector remains a pure
copier. An incomplete tail stays behind the acknowledged cursor and is retried
verbatim after its newline arrives. A record larger than the target chunk size
is sent as one larger, bounded record chunk rather than split.

If an epoch closes while it still has a partial tail, the connector reports the
tail as a separate archival fragment with its byte range and hash. It is kept
for diagnostics but receives no `rawLineSeq` and is never JSON-decoded.

## Ingest object

One connector frame carries metadata plus raw bytes. The exact transport may be
binary WebSocket data or base64 JSON; the logical object is:

```json
{
  "type": "transcript.chunk.v1",
  "ownerId": "authenticated-owner",
  "machineAgentId": "machine-uuid",
  "sourceId": "source-uuid",
  "agentKind": "claude",
  "agentSessionId": "session-uuid",
  "pathFingerprint": "hmac-sha256:...",
  "fileEpoch": "epoch-uuid",
  "startOffset": 1048576,
  "endOffsetExclusive": 1114112,
  "firstLineSeq": 812,
  "nextLineSeq": 861,
  "observation": {
    "fileSize": 1114112,
    "mtimeMs": 1783785600000,
    "observedAt": "2026-07-12T00:00:00Z"
  },
  "content": {
    "encoding": "identity",
    "bodySha256": "sha256:...",
    "base64": "..."
  }
}
```

The controller derives `ownerId` from connector authentication and rejects a
conflicting payload value. It verifies byte length and content hash before
storing the chunk.

## Byte offsets, raw line sequence, and partial lines

Byte offset is the authoritative replication cursor. `rawLineSeq` is the
human- and decoder-friendly physical ordering coordinate.

For every epoch, the archive index holds:

```text
committedOffset              contiguous durable newline-complete byte prefix
nextLineSeq                  sequence assigned to the next complete line
partialLineStartOffset       start of a buffered non-newline-terminated suffix
```

Rules:

1. Bytes are ordered only by `(fileEpoch, byte offset)`, never by timestamp.
2. A complete line increments `rawLineSeq` exactly once.
3. A partial last line is not acknowledged as a line or included in a normal
   chunk. It remains at the local byte cursor until completed.
4. If the epoch closes with a partial line, retain a separately marked
   `truncated_line` fragment; do not invent a JSON record or increment line
   sequence.
5. Decoder filtering does not renumber raw lines. Tool records and metadata keep
   their physical positions even when they produce no dialogue turn.

The distinction is essential: raw-line sequence, vendor message sequence,
clean-dialogue sequence, and human conversational turn sequence are different
things.

## ACK and ingest idempotency

Transport is retried until the controller returns a durable ACK. The controller
must commit the raw object and contiguous-range index before sending it.

```json
{
  "type": "transcript.ack.v1",
  "sourceId": "source-uuid",
  "fileEpoch": "epoch-uuid",
  "accepted": true,
  "committedOffset": 1114112,
  "nextLineSeq": 861,
  "liveWatermarkId": "watermark-uuid"
}
```

An ingest idempotency key is:

```text
ChunkKey = sha256(
  MachineKey || sourceId || fileEpoch || startOffset || endOffsetExclusive || bodySha256
)
```

Handling retries and conflicts:

- exact duplicate: return the existing ACK;
- range begins at the committed offset: append and advance;
- range begins after the committed offset: NACK with `expectedStartOffset`;
- overlapping bytes match archived bytes: accept as replay and return the
  contiguous ACK;
- overlapping bytes differ: mark `epoch_conflict`, stop decoding that epoch,
  and ask the connector to open a new epoch;
- archive storage succeeds but index transaction fails: do not ACK; retry is
  harmless because the object key is content-addressed.

Raw-archive ACK and decoder ACK are intentionally separate. An unknown or bad
JSON record must not block replication of later bytes.

## Live watermark

A live watermark means “the controller has archived every complete JSONL record
the connector observed through this byte,” not “the agent turn is complete.”

The connector sends a watermark after a stat observation, including when no new
bytes exist:

```json
{
  "type": "transcript.watermark.v1",
  "sourceId": "source-uuid",
  "fileEpoch": "epoch-uuid",
  "observedFileSize": 1114112,
  "observedCompleteOffset": 1114112,
  "partialTailBytes": 0,
  "observedAt": "2026-07-12T00:00:00Z",
  "unchangedSince": "2026-07-11T23:59:58Z"
}
```

The controller publishes it as live only when the contiguous archived prefix
reaches `observedCompleteOffset`. `observedFileSize` may be larger while the
writer has an incomplete final record. Operational state exposes four
independent lags:

- replication lag: observed complete offset minus committed byte offset;
- framing lag: uncommitted partial-tail byte count;
- decoder lag: last complete raw line minus decoder checkpoint;
- delivery lag: decoded outbox sequence minus delivered outbox sequence.

EOF stability and `unchangedSince` may satisfy a decoder settle timer, but they
are not terminal markers. A long-lived CLI transcript can remain unchanged for
minutes and then append another turn.

## Raw archive layout

Raw chunks are immutable, compressed after verification, and encrypted at rest.
One possible object key is:

```text
raw/v1/<owner-hash>/<machine-id>/<source-id>/<file-epoch>/
  <start-offset>-<end-offset>-<content-sha>.jsonl.zst
```

A transactional metadata store holds source manifests, ranges, watermarks,
decoder checkpoints, and outbox rows. Object names contain no email, hostname,
project directory, prompt, or session title.

## Central decoder contract

Every decoder is selected by `(agentKind, schema family, decoder version)` and
consumes complete raw lines in `rawLineSeq` order. It must:

1. parse one physical line without executing or fetching anything referenced by
   that line;
2. preserve its `RawLineKey` and byte range;
3. validate session identity and supported schema/version;
4. update a replayable state machine;
5. emit normalized events into the same durable transaction as its checkpoint;
6. never publish from an unknown record shape merely because it contains text.

Timestamps are descriptive metadata. They may be missing, equal, or move
backward; they never replace physical order. Parent UUID graphs may be resolved
after later lines arrive and are not required to be topologically ordered on
disk.

### Common normalized states

```text
running
waiting_for_input
completed_candidate
completed_confirmed
cancelled
failed
unknown
```

Events carry `confidence: confirmed | inferred`, decoder version, source raw
coordinates, and the reason used to reach the state.

## Claude decoder

### Record assembly

- Validate top-level `sessionId`, `uuid`, `parentUuid`, `isSidechain`, `type`,
  and `version` when present.
- Group assistant records by `message.id`. A message ID repeats across thinking,
  text, and tool-use records and is not a raw-line ID.
- Within a message group, preserve physical order and use the final non-null
  `message.stop_reason` only after the group has settled at the live watermark.
- Use the per-record UUID as the semantic source ID when valid.
- Main-channel Event Radio ignores `isSidechain: true` by default. Sidechain
  events may be archived and exposed to a separate diagnostics stream.
- Extract spoken text only from allowed text content blocks. Thinking, tool
  inputs/results, injected system context, and secrets are not broadcast text.

### Completion rules

The strongest observed marker is:

```text
type == "system"
subtype == "stop_hook_summary"
preventedContinuation == false
parentUuid resolves to a main-channel assistant message whose final
stop_reason == "end_turn"
```

When present, emit `agent.turn.completed` with `confidence: confirmed`. If
`preventedContinuation` is true, do not emit completion; the turn continues.

The target architecture does not install a Stop hook, so this marker is an
optional confirmation, not a dependency. Without it, a main-channel
`end_turn` becomes `completed_candidate`. Promote it to an inferred completion
only after all of these hold:

1. a live watermark covers the final message record;
2. a configurable settle interval passes with no child or later same-channel
   assistant continuation;
3. no interruption, API error, or continuation marker supersedes it;
4. the controller's independently observed pane state is idle, when that signal
   is available.

This fallback is intentionally labeled inferred. Aggregate evidence includes
real `end_turn` records followed immediately by another assistant message
without an intervening user message, so `end_turn` alone is not exact.

### Tool use and waiting

- `stop_reason == "tool_use"` is intermediate, not completion.
- Track each `tool_use.id` until the matching `tool_result.tool_use_id` appears.
- An unresolved `AskUserQuestion` tool use emits `agent.turn.waiting_for_input`.
  A matching result resolves that waiting state and the turn continues.
- An unresolved non-question tool use is `running_or_blocked`; transcript data
  alone cannot distinguish active execution, a permission dialog, disconnection,
  or a crash. Do not announce completion.
- Permission waiting requires the existing pane/Ask/approval detectors or a
  future explicit CLI lifecycle record; it must not be guessed from elapsed
  time.

### Abnormal endings

- `max_tokens` is a continuation/truncation condition, not a normal completion.
- `stop_sequence`, `isApiErrorMessage`, or a `system/api_error` record produces
  a failed/abnormal candidate according to the supported schema, never a normal
  completion by default.
- A user interruption marker or `interruptedMessageId` produces
  `agent.turn.cancelled` and invalidates any pending completion candidate.
- A missing/null stop reason remains incomplete. File EOF does not upgrade it.
- `system/turn_duration` is telemetry only; it has been observed after
  `end_turn`, `tool_use`, and error records and is not a terminal marker.

## Codex decoder

The existing repository reader recognizes Codex `response_item` records whose
payload is a user/assistant message. Those records provide dialogue text, not a
completion boundary. For the currently fixture-backed lifecycle schema, the
terminal records are `event_msg` objects whose `payload.type` is
`task_complete` or `turn_aborted`.

For a schema version covered by fixtures, the central decoder should:

- derive the session from the supported session metadata record and validate it
  against the source hint;
- preserve physical record order and any vendor item/turn IDs;
- treat assistant `response_item` text as content only;
- start a turn from the supported explicit turn-start lifecycle record;
- confirm completion from
  `type == "event_msg" && payload.type == "task_complete"`, requiring a
  non-empty `payload.turn_id`;
- use `payload.last_agent_message` as the final text only after that terminal
  marker, not when it first appears in a `response_item`;
- map
  `type == "event_msg" && payload.type == "turn_aborted"` with a non-empty
  `payload.turn_id` to an aborted event;
- ignore legacy aborted records without a turn ID for the central event path,
  because they cannot receive a deterministic per-turn identity;
- map other fixture-backed cancelled and failed lifecycle records separately;
- treat approval requests, questions, and tool calls as waiting/running until
  their corresponding resolution record arrives.

Field names and shapes outside tested Codex fixtures are not guessed. If a
Codex version has no recognized terminal lifecycle record, the decoder may
produce a settled, idle-backed `completed_candidate`, but it must not label it
confirmed. In particular, the last assistant `response_item`, file EOF, and an
unchanged watermark are insufficient on their own.

## Normalized event and outbox

```json
{
  "schemaVersion": 1,
  "type": "agent.turn.completed",
  "eventId": "evt_sha256_...",
  "ownerId": "authenticated-owner",
  "machineAgentId": "machine-uuid",
  "agentKind": "claude",
  "vendorSessionId": "session-uuid",
  "confidence": "confirmed",
  "reason": "stop_hook_summary",
  "occurredAt": "2026-07-12T00:00:00Z",
  "observedAt": "2026-07-12T00:00:01Z",
  "source": {
    "sourceId": "source-uuid",
    "fileEpoch": "epoch-uuid",
    "rawLineSeq": 860,
    "byteStart": 1113900,
    "byteEnd": 1114079,
    "recordUuid": "record-uuid"
  },
  "payload": {
    "finalText": "redacted-and-size-limited text",
    "waitingTool": null
  },
  "decoder": {
    "name": "claude-jsonl",
    "version": 1
  }
}
```

The stable event ID is independent of decoder deployment version:

```text
eventId = sha256(
  normalizedEventType || SessionKey || stableSemanticSourceRecordId
)
```

This prevents decoder replay and SQS redelivery from rebroadcasting the same
completion. A decoder correction that intentionally changes an already emitted
event uses an explicit revision/supersedes relation rather than silently making
a new ID.

The decoder checkpoint and outbox insert commit atomically. An outbox worker
publishes to SQS with `eventId`; it marks delivery only after SQS accepts the
message. Consumers keep a durable idempotency record keyed by `eventId` because
Standard SQS is at-least-once.

## Unknown formats and decoder failures

Raw replication always wins over speculative decoding.

- Unknown top-level type: archive and count it; do not emit an event.
- Unsupported vendor/schema version: set `unsupported_version`, retain raw data
  for the configured replay window, and alert on the new fingerprint.
- Malformed complete line: record `malformed_json` at its RawLineKey and continue
  replication; decoder policy may quarantine the epoch or skip only that line.
- Partial line: wait for its newline; never mark malformed while the file is
  still live.
- Duplicate vendor UUID with identical bytes: idempotent replay.
- Duplicate vendor UUID with different bytes, session conflict, or contradictory
  parent graph: quarantine the affected session and publish nothing.
- Decoder crash: raw ACK remains valid; restart from the last transactional
  decoder checkpoint.
- Gap in byte ranges: do not decode beyond the gap, NACK the connector with the
  expected offset.
- Source deleted before unacknowledged bytes are copied: report permanent data
  loss explicitly; do not advance a synthetic cursor.

Unknown records and errors must never include raw transcript content or local
paths in logs.

## Privacy and security

Transcripts can contain prompts, source code, command output, credentials,
customer data, tool inputs, and model reasoning. Treat the raw archive as a
high-sensitivity data store.

Required controls:

- authenticate every connector frame and scope every object by owner;
- TLS in transit and managed encryption at rest, with separate production keys;
- no public bucket/object access or presigned raw-transcript links;
- least-privilege ingest, decoder, and outbox service identities;
- allowlisted transcript roots and regular-file checks on the connector;
- no raw path, prompt, response, tool input/result, UUID value, or project name
  in application logs and metrics;
- content-length limits, decompression limits, and JSON nesting limits;
- decoder output allowlists and size limits before TTS or any external model;
- never speak thinking blocks, tool payloads, environment context, or secrets;
- owner-authorized export and deletion with an auditable tombstone;
- production diagnostics use aggregate counts and source IDs, not content.

`finalText` is still sensitive. Event Radio should receive only the minimum
sanitized text needed for narration, not the raw transcript or tool history.

## Retention

Retention is configurable per environment and owner. Recommended policy shape:

- pending local spool: until raw archive ACK, then delete promptly;
- raw encrypted chunks: short replay window, for example 30 days;
- decoder checkpoints and manifests: source lifetime plus a recovery window;
- normalized event payloads: shorter than or equal to the product-required
  event history;
- minimal event-ID dedup tombstones: long enough to cover archive replay, SQS
  redelivery, and disaster recovery, without retaining transcript text;
- quarantined/unknown raw data: same or shorter limit than normal raw data,
  never indefinite by accident.

Object-store lifecycle rules enforce expiry. User/machine deletion cascades to
raw objects, decoded payloads, manifests, outbox rows, and derived narration;
non-content audit tombstones retain only opaque IDs and deletion time.

## No local Stop hook

This design must work on a newly connected machine without changing:

- `~/.claude/settings.json`
- `~/.codex/config.toml`
- `~/.codex/hooks/hooks.json`

The connector's existing long-running outbound connection is the only local
runtime dependency. Optional lifecycle records written by a CLI or by hooks
already configured by the owner can improve central confidence, but the system
does not install, invoke, or require those hooks.

This also means Claude completion without an explicit lifecycle record is
inferred rather than guaranteed. The API and Event Radio policy must preserve
that confidence label instead of hiding the limitation.

## Empirical basis for the Claude rules

An aggregate-only scan of a live local Claude Code 2.1 transcript corpus was
used to validate the design. No transcript content, project path, or identifier
value was emitted by the scan. At the time of inspection:

- no top-level or nested `sequence`, `seq`, or `index` field existed;
- record UUIDs covered roughly 77% of physical lines and were unique across the
  inspected corpus, while metadata lines commonly had no UUID;
- every observed UUID parent reference resolved in the same file, with a small
  number pointing to a physically later line;
- timestamps were optional, duplicated, and sometimes moved backward;
- repeated exact raw lines were UUID-less mode/title/permission metadata, not
  duplicated UUID-bearing message records;
- `message.id` repeated across assistant records and therefore identified a
  message group, not a raw line;
- every observed `stop_hook_summary` linked to a main-channel `end_turn`, but
  two main `end_turn` groups without that summary continued immediately with a
  different assistant message and no intervening user record;
- AskUserQuestion appeared as `tool_use`, and its later answer appeared as the
  matching tool result;
- `turn_duration`, `stop_sequence`, `max_tokens`, and null stop reasons were not
  reliable normal-completion markers.

These observations justify byte/epoch identity, central replayable decoders,
and conservative completion confidence. They are regression evidence, not a
vendor schema guarantee; fixtures and production schema metrics remain
required.

## Rollout and observability

Roll out archive replication separately from event publication:

1. archive bytes and validate ACK/reconnect/epoch behavior with decoders off;
2. run decoders in shadow mode and compare normalized state with Command Center;
3. enable outbox writes without SQS publication and audit dedup/replay;
4. publish only confirmed events;
5. explicitly decide whether Event Radio accepts inferred Claude completions;
6. add Codex versions only after fixture-backed lifecycle tests pass.

Minimum metrics, all content-free:

- sources and epochs by kind/status;
- replication, framing, decoder, and outbox lag;
- bytes/chunks accepted, retried, overlapped, conflicted, and missing;
- malformed/unknown records by schema fingerprint and decoder version;
- candidate/confirmed/waiting/cancelled/failed events by agent kind;
- inferred-completion rate and later-continuation false-positive rate;
- event-ID dedup hits and SQS delivery retries;
- local spool size and oldest unacknowledged byte age.

Alert on byte gaps, epoch conflicts, unsupported schema growth, decoder lag,
spool pressure, and any inferred completion later contradicted by continuation.
