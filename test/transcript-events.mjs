import assert from "node:assert/strict";
import {
  createTranscriptDecoderState,
  createTranscriptEventDecoder,
  decodeTranscriptRecord,
  settleTranscriptDecoder,
} from "../lib/transcript-events.mjs";

function codexSessionMeta({ sessionId = "codex-session", version = "0.144.1" } = {}) {
  return {
    timestamp: "2026-07-12T00:00:00.000Z",
    type: "session_meta",
    payload: { id: sessionId, cli_version: version },
  };
}

function codexMarker(type, turnId, overrides = {}) {
  return {
    timestamp: overrides.timestamp || "2026-07-12T00:00:01.000Z",
    type: "event_msg",
    payload: {
      type,
      ...(turnId ? { turn_id: turnId } : {}),
      ...overrides.payload,
    },
  };
}

function claudeAssistant({
  sessionId = "claude-session",
  uuid = "assistant-record",
  messageId = "assistant-message",
  stopReason = "end_turn",
  content = [{ type: "text", text: "Finished the requested work." }],
  isSidechain = false,
  timestamp = "2026-07-12T01:00:00.000Z",
} = {}) {
  return {
    type: "assistant",
    sessionId,
    uuid,
    timestamp,
    isSidechain,
    version: "2.1.0",
    message: {
      id: messageId,
      role: "assistant",
      stop_reason: stopReason,
      content,
    },
  };
}

function claudeUser({
  sessionId = "claude-session",
  uuid = "user-record",
  parentUuid = "assistant-record",
  content = "continue",
  isSidechain = false,
  timestamp = "2026-07-12T01:00:01.000Z",
} = {}) {
  return {
    type: "user",
    sessionId,
    uuid,
    parentUuid,
    timestamp,
    isSidechain,
    message: { role: "user", content },
  };
}

function settleEvidence(sourceRecordId) {
  return {
    settleEvidence: {
      sourceRecordId,
      liveWatermark: true,
      quiet: true,
    },
  };
}

// Codex only trusts explicit, versioned event_msg terminal markers. Assistant
// response records and task_started are not inferred as completion.
const codex = createTranscriptEventDecoder({ machineId: "machine-a", kind: "codex" });
assert.deepEqual(codex.push(codexSessionMeta()), []);
assert.deepEqual(
  codex.push({
    timestamp: "2026-07-12T00:00:00.500Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Not a terminal marker" }],
    },
  }),
  [],
);
assert.deepEqual(codex.push(codexMarker("task_started", "turn-1")), []);

const codexCompleteRecord = codexMarker("task_complete", "turn-1", {
  payload: { last_agent_message: "  Build and tests passed.  " },
});
const [codexComplete] = codex.push(codexCompleteRecord);
assert.equal(codexComplete.schemaVersion, 1);
assert.equal(codexComplete.source, "codex");
assert.equal(codexComplete.sourceSchema, "codex.event_msg.turn.v1");
assert.equal(codexComplete.sourceVersion, "0.144.1");
assert.equal(codexComplete.type, "agent.turn.completed");
assert.equal(codexComplete.outcome, "completed");
assert.equal(codexComplete.machineId, "machine-a");
assert.equal(codexComplete.sessionId, "codex-session");
assert.equal(codexComplete.turnId, "turn-1");
assert.equal(codexComplete.text, "Build and tests passed.");
assert.equal(codexComplete.reason, null);
assert.deepEqual(codex.push(codexCompleteRecord), [], "replayed Codex terminal is idempotent");

const [codexAborted] = codex.push(
  codexMarker("turn_aborted", "turn-2", { payload: { reason: "interrupted" } }),
);
assert.equal(codexAborted.type, "agent.turn.aborted");
assert.equal(codexAborted.outcome, "aborted");
assert.equal(codexAborted.reason, "interrupted");
assert.deepEqual(
  codex.push(codexMarker("turn_aborted", null, { payload: { reason: "interrupted" } })),
  [],
  "legacy Codex abort without turn_id is not assigned an unsafe identity",
);

const codexAgain = createTranscriptEventDecoder({ machineId: "machine-a", kind: "codex" });
codexAgain.push(codexSessionMeta());
assert.equal(
  codexAgain.push(codexCompleteRecord)[0].eventId,
  codexComplete.eventId,
  "the same source marker and context produce the same event id",
);

// Claude main-chain end_turn is pending until settle(). Sidechain activity does
// not emit and does not cancel the pending main-chain event.
const claude = createTranscriptEventDecoder({ machineId: "machine-a", kind: "claude" });
const pendingMain = claudeAssistant({ uuid: "main-end", messageId: "msg-main" });
assert.deepEqual(claude.push(pendingMain), []);
assert.deepEqual(
  claude.push(
    claudeAssistant({
      uuid: "side-end",
      messageId: "msg-side",
      isSidechain: true,
      content: [{ type: "text", text: "Subagent result" }],
    }),
  ),
  [],
);
assert.deepEqual(
  claude.settle(),
  [],
  "chunk EOF without live-watermark/quiet evidence never settles Claude",
);
const [settledMain] = claude.settle(settleEvidence("main-end"));
assert.equal(settledMain.type, "agent.turn.completed");
assert.equal(settledMain.outcome, "completed");
assert.equal(settledMain.turnId, "main-end");
assert.equal(settledMain.text, "Finished the requested work.");
assert.equal(settledMain.sourceVersion, "2.1.0");
assert.deepEqual(claude.settle(), [], "settle is idempotent");

// A later main-chain assistant fragment cancels an unsettled end_turn. A later
// end_turn becomes the new candidate rather than emitting the earlier one.
const continuation = createTranscriptEventDecoder({ kind: "claude" });
continuation.push(claudeAssistant({ uuid: "premature-end" }));
assert.deepEqual(
  continuation.push(
    claudeAssistant({
      uuid: "continued-fragment",
      messageId: "continued-message",
      stopReason: null,
      content: [{ type: "text", text: "Continuing after a streamed boundary" }],
    }),
  ),
  [],
);
assert.deepEqual(continuation.settle(), [], "continuation cancels pending end_turn");
continuation.push(
  claudeAssistant({
    uuid: "actual-end",
    messageId: "actual-message",
    content: [{ type: "text", text: "Actually finished" }],
  }),
);
assert.equal(
  continuation.settle(settleEvidence("actual-end"))[0].turnId,
  "actual-end",
);

const fastReply = createTranscriptEventDecoder({ kind: "claude" });
fastReply.push(claudeAssistant({ uuid: "end-before-fast-reply" }));
const [confirmedByUser] = fastReply.push(
  claudeUser({ uuid: "fast-reply", content: "Here is the next request" }),
);
assert.equal(
  confirmedByUser.turnId,
  "end-before-fast-reply",
  "a genuine next prompt confirms the previous end_turn",
);
assert.deepEqual(fastReply.settle(), []);

const replacement = createTranscriptEventDecoder({ kind: "claude" });
replacement.push(claudeAssistant({ uuid: "first-end" }));
replacement.push(claudeAssistant({ uuid: "replacement-end" }));
assert.equal(
  replacement.settle(settleEvidence("replacement-end"))[0].turnId,
  "replacement-end",
  "a subsequent end_turn replaces the earlier pending candidate",
);

// Generic tool use is continuation machinery. AskUserQuestion is the one
// tool_use promoted to a normalized needs_input event.
const tools = createTranscriptEventDecoder({ kind: "claude", machineId: "machine-a" });
assert.deepEqual(
  tools.push(
    claudeAssistant({
      uuid: "bash-use",
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: "tool-bash", name: "Bash", input: {} }],
    }),
  ),
  [],
);
assert.deepEqual(tools.settle(), []);

const askRecord = claudeAssistant({
  uuid: "ask-record",
  stopReason: "tool_use",
  content: [
    { type: "text", text: "I need one decision." },
    {
      type: "tool_use",
      id: "ask-tool-1",
      name: "AskUserQuestion",
      input: { questions: [{ question: "Which environment should be used?" }] },
    },
  ],
});
const [needsInput] = tools.push(askRecord);
assert.equal(needsInput.type, "agent.needs_input");
assert.equal(needsInput.outcome, "needs_input");
assert.equal(needsInput.reason, "AskUserQuestion");
assert.equal(needsInput.text, "Which environment should be used?");
assert.deepEqual(tools.push(askRecord), [], "replayed AskUserQuestion is idempotent");
assert.deepEqual(tools.settle(), [], "AskUserQuestion is not a pending completion");
assert.deepEqual(
  tools.push(
    claudeAssistant({
      uuid: "side-ask",
      isSidechain: true,
      stopReason: "tool_use",
      content: [
        { type: "tool_use", id: "side-ask-tool", name: "AskUserQuestion", input: {} },
      ],
    }),
  ),
  [],
  "sidechain AskUserQuestion is filtered",
);

// The explicit Claude interruption row cancels a pending completion and emits
// one terminal abort. A marker nested inside tool_result is not an interrupt.
const interrupted = createTranscriptEventDecoder({ kind: "claude", machineId: "machine-a" });
interrupted.push(claudeAssistant({ uuid: "interrupted-turn" }));
const [abort] = interrupted.push(
  claudeUser({
    uuid: "interrupt-row",
    parentUuid: "interrupted-turn",
    content: "[Request interrupted by user]",
  }),
);
assert.equal(abort.type, "agent.turn.aborted");
assert.equal(abort.reason, "interrupted");
assert.equal(abort.turnId, "interrupted-turn");
assert.deepEqual(interrupted.settle(), []);

const fakeInterrupt = createTranscriptEventDecoder({ kind: "claude" });
fakeInterrupt.push(claudeAssistant({ uuid: "end-before-tool-result" }));
assert.deepEqual(
  fakeInterrupt.push(
    claudeUser({
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "[Request interrupted by user]",
        },
      ],
    }),
  ),
  [],
);
assert.deepEqual(fakeInterrupt.settle(), [], "tool_result continuation cancels pending end_turn");

// The reducer API is serializable and equivalent to the convenience facade.
let state = createTranscriptDecoderState({ kind: "claude", machineId: "machine-a" });
({ state } = decodeTranscriptRecord(claudeAssistant({ uuid: "functional-end" }), state));
const functional = settleTranscriptDecoder(state, settleEvidence("functional-end"));
assert.equal(functional.events.length, 1);
assert.equal(functional.events[0].turnId, "functional-end");
assert.deepEqual(settleTranscriptDecoder(functional.state).events, []);

console.log("transcript-events unit tests passed");
