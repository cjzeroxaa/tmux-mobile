import { createHash } from "node:crypto";

export const TRANSCRIPT_EVENT_SCHEMA_VERSION = 1;
export const TRANSCRIPT_DECODER_STATE_VERSION = 1;

const CLAUDE_INTERRUPT_MARKER = "[Request interrupted by user]";
const CLAUDE_ASK_USER_TOOL = "AskUserQuestion";

/**
 * Create serializable state for the transcript event decoder.
 *
 * `context` may contain agentKind/kind/source, machineId, sessionId, and
 * sourceVersion. Supplying machineId makes event ids safe to merge across
 * machines. The decoder still works without it for local, per-machine use.
 */
export function createTranscriptDecoderState(context = {}) {
  return {
    decoderStateVersion: TRANSCRIPT_DECODER_STATE_VERSION,
    context: mergeContext(emptyContext(), context),
    pendingClaudeEndTurn: null,
    emittedEventIds: {},
  };
}

/**
 * Decode one already-parsed JSONL record.
 *
 * Returns a new serializable state plus zero or more normalized events. Codex
 * terminal markers emit immediately. Claude `end_turn` is intentionally held
 * until settleTranscriptDecoder() so a continuation can cancel it first.
 */
export function decodeTranscriptRecord(record, state, context = {}) {
  let next = normalizeState(state, context);
  const inferredKind = normalizeAgentKind(next.context.agentKind) || inferAgentKind(record);

  if (!inferredKind || !isObject(record)) return { state: next, events: [] };

  // A Claude sidechain has its own records and message ids but is not a user
  // turn in the main agent session. It must not emit or cancel a pending main-
  // chain completion.
  if (inferredKind === "claude" && record.isSidechain === true) {
    return { state: next, events: [] };
  }

  const previousSessionId = next.context.sessionId;
  next = {
    ...next,
    context: contextFromRecord(next.context, inferredKind, record),
  };
  if (
    previousSessionId &&
    next.context.sessionId &&
    previousSessionId !== next.context.sessionId
  ) {
    next = { ...next, pendingClaudeEndTurn: null };
  }

  return inferredKind === "codex"
    ? decodeCodexRecord(record, next)
    : decodeClaudeRecord(record, next);
}

/**
 * Emit a pending Claude main-chain end_turn only when the caller supplies
 * explicit evidence that a live watermark covers this exact source record and
 * a quiet interval has elapsed. Ordinary chunk EOF/end-of-batch is never enough
 * evidence: real Claude transcripts contain same-turn continuations after an
 * apparent end_turn. Calling settle repeatedly is idempotent.
 */
export function settleTranscriptDecoder(state, context = {}) {
  let next = normalizeState(state, context);
  const pending = next.pendingClaudeEndTurn;
  if (!pending) return { state: next, events: [] };
  if (!settleEvidenceCoversPending(context.settleEvidence, pending)) {
    return { state: next, events: [] };
  }

  next = { ...next, pendingClaudeEndTurn: null };
  return emitOnce(next, pending.event);
}

/**
 * Small stateful facade for stream consumers. The underlying reducer exports
 * above remain available when the caller wants to persist decoder state.
 */
export function createTranscriptEventDecoder(context = {}) {
  let state = createTranscriptDecoderState(context);
  return {
    push(record, recordContext = {}) {
      const result = decodeTranscriptRecord(record, state, recordContext);
      state = result.state;
      return result.events;
    },
    settle(settleContext = {}) {
      const result = settleTranscriptDecoder(state, settleContext);
      state = result.state;
      return result.events;
    },
    getState() {
      return state;
    },
  };
}

function decodeCodexRecord(record, state) {
  const payload = isObject(record.payload) ? record.payload : null;
  if (record.type !== "event_msg" || !payload) return { state, events: [] };

  const marker = payload.type;
  if (marker !== "task_complete" && marker !== "turn_aborted") {
    return { state, events: [] };
  }

  // Old Codex turn_aborted rows did not carry a turn_id. They are useful for
  // display but cannot be paired or given a deterministic per-turn identity,
  // so the central event path deliberately ignores them.
  const turnId = nonEmptyString(payload.turn_id);
  if (!turnId) return { state, events: [] };

  const completed = marker === "task_complete";
  const event = normalizedEvent({
    context: state.context,
    source: "codex",
    sourceSchema: "codex.event_msg.turn.v1",
    type: completed ? "agent.turn.completed" : "agent.turn.aborted",
    outcome: completed ? "completed" : "aborted",
    turnId,
    occurredAt: timestampFromRecord(record),
    text: completed ? stringOrEmpty(payload.last_agent_message) : "",
    reason: completed ? null : nullableString(payload.reason),
    identityKind: "terminal",
  });
  return emitOnce(state, event);
}

function decodeClaudeRecord(record, state) {
  if (record.type !== "assistant" && record.type !== "user") {
    return { state, events: [] };
  }

  const message = isObject(record.message) ? record.message : null;
  if (!message) return { state, events: [] };

  if (record.type === "user" && message.role === "user") {
    const pending = state.pendingClaudeEndTurn;
    if (!isClaudeInterruptMessage(message)) {
      if (!pending) return { state, events: [] };
      if (isClaudeToolResultMessage(message)) {
        return { state: { ...state, pendingClaudeEndTurn: null }, events: [] };
      }
      if (!isRealClaudeUserMessage(message)) {
        return { state, events: [] };
      }
      // A genuine next prompt proves the preceding main-chain end_turn did
      // return control to the user, even if it arrived before the quiet timer.
      const completed = emitOnce(
        { ...state, pendingClaudeEndTurn: null },
        pending.event,
      );
      return completed;
    }

    let next = pending ? { ...state, pendingClaudeEndTurn: null } : state;

    const turnId =
      pending?.event?.turnId ||
      nonEmptyString(record.parentUuid) ||
      nonEmptyString(record.uuid) ||
      fallbackClaudeTurnId(record, message);
    const event = normalizedEvent({
      context: next.context,
      source: "claude",
      sourceSchema: "claude.main_chain.interrupt.v1",
      type: "agent.turn.aborted",
      outcome: "aborted",
      turnId,
      occurredAt: timestampFromRecord(record),
      text: "",
      reason: "interrupted",
      identityKind: "terminal",
    });
    return emitOnce(next, event);
  }

  if (record.type !== "assistant" || message.role !== "assistant") {
    return { state, events: [] };
  }

  const blocks = Array.isArray(message.content) ? message.content.filter(isObject) : [];
  const toolUses = blocks.filter((block) => block.type === "tool_use");
  const askUserTools = toolUses.filter((block) => block.name === CLAUDE_ASK_USER_TOOL);
  const stopReason = nullableString(message.stop_reason || record.stop_reason);
  const sourceRecordId = claudeSourceRecordId(record, message);

  // Replayed copies of the same pending end_turn are harmless and should not
  // replace the pending candidate or change its event id.
  if (
    stopReason === "end_turn" &&
    state.pendingClaudeEndTurn?.sourceRecordId === sourceRecordId
  ) {
    return { state, events: [] };
  }

  // Any new main-chain assistant record proves that a previously observed
  // end_turn was not yet settled. This covers streaming continuations and the
  // tool-use continuation pattern.
  let next = state.pendingClaudeEndTurn
    ? { ...state, pendingClaudeEndTurn: null }
    : state;

  if (askUserTools.length > 0) {
    let events = [];
    for (let index = 0; index < askUserTools.length; index += 1) {
      const toolUse = askUserTools[index];
      const toolUseId =
        nonEmptyString(toolUse.id) || `${sourceRecordId}:ask-user:${index}`;
      const turnId =
        nonEmptyString(record.uuid) ||
        nonEmptyString(message.id) ||
        fallbackClaudeTurnId(record, message);
      const event = normalizedEvent({
        context: next.context,
        source: "claude",
        sourceSchema: "claude.main_chain.ask_user.v1",
        type: "agent.needs_input",
        outcome: "needs_input",
        turnId,
        occurredAt: timestampFromRecord(record),
        text: questionText(toolUse.input),
        reason: "AskUserQuestion",
        identityKind: `needs_input:${toolUseId}`,
      });
      const emitted = emitOnce(next, event);
      next = emitted.state;
      events = events.concat(emitted.events);
    }
    return { state: next, events };
  }

  // Generic tool_use blocks and all non-end_turn assistant fragments are
  // continuation mechanics, not completed user turns.
  if (toolUses.length > 0 || stopReason !== "end_turn") {
    return { state: next, events: [] };
  }

  const turnId =
    nonEmptyString(record.uuid) ||
    nonEmptyString(message.id) ||
    fallbackClaudeTurnId(record, message);
  const event = normalizedEvent({
    context: next.context,
    source: "claude",
    sourceSchema: "claude.main_chain.end_turn.v1",
    type: "agent.turn.completed",
    outcome: "completed",
    turnId,
    occurredAt: timestampFromRecord(record),
    text: claudeAssistantText(message),
    reason: null,
    identityKind: "terminal",
  });
  return {
    state: {
      ...next,
      pendingClaudeEndTurn: { sourceRecordId, event },
    },
    events: [],
  };
}

function normalizedEvent({
  context,
  source,
  sourceSchema,
  type,
  outcome,
  turnId,
  occurredAt,
  text,
  reason,
  identityKind,
}) {
  const machineId = nonEmptyString(context.machineId);
  const sessionId = nonEmptyString(context.sessionId);
  return {
    schemaVersion: TRANSCRIPT_EVENT_SCHEMA_VERSION,
    eventId: deterministicEventId([
      machineId || "local",
      source,
      sessionId || "unknown-session",
      turnId,
      identityKind,
    ]),
    source,
    sourceSchema,
    sourceVersion: nonEmptyString(context.sourceVersion),
    type,
    outcome,
    machineId,
    sessionId,
    turnId,
    occurredAt,
    text: stringOrEmpty(text).trim(),
    reason: nullableString(reason),
  };
}

function settleEvidenceCoversPending(evidence, pending) {
  return Boolean(
    isObject(evidence) &&
      evidence.liveWatermark === true &&
      evidence.quiet === true &&
      nonEmptyString(evidence.sourceRecordId) === pending.sourceRecordId,
  );
}

function emitOnce(state, event) {
  if (state.emittedEventIds[event.eventId]) return { state, events: [] };
  return {
    state: {
      ...state,
      emittedEventIds: { ...state.emittedEventIds, [event.eventId]: true },
    },
    events: [event],
  };
}

function normalizeState(state, context) {
  const base =
    isObject(state) && state.decoderStateVersion === TRANSCRIPT_DECODER_STATE_VERSION
      ? state
      : createTranscriptDecoderState();
  return {
    ...base,
    context: mergeContext(base.context || emptyContext(), context),
    emittedEventIds: isObject(base.emittedEventIds) ? base.emittedEventIds : {},
  };
}

function contextFromRecord(context, kind, record) {
  let next = mergeContext(context, { agentKind: kind });
  if (kind === "codex" && record.type === "session_meta" && isObject(record.payload)) {
    next = mergeContext(next, {
      sessionId: record.payload.id,
      sourceVersion: record.payload.cli_version,
    });
  } else if (kind === "claude") {
    next = mergeContext(next, {
      sessionId: record.sessionId,
      sourceVersion: record.version,
    });
  }
  return next;
}

function emptyContext() {
  return {
    agentKind: null,
    machineId: null,
    sessionId: null,
    sourceVersion: null,
  };
}

function mergeContext(base, extra) {
  if (!isObject(extra)) return { ...emptyContext(), ...base };
  const next = { ...emptyContext(), ...base };
  const agentKind = normalizeAgentKind(extra.agentKind || extra.kind || extra.source);
  if (agentKind) next.agentKind = agentKind;
  for (const key of ["machineId", "sessionId", "sourceVersion"]) {
    const value = nonEmptyString(extra[key]);
    if (value) next[key] = value;
  }
  return next;
}

function inferAgentKind(record) {
  if (!isObject(record)) return null;
  if (
    record.type === "session_meta" ||
    record.type === "event_msg" ||
    record.type === "response_item" ||
    record.type === "turn_context"
  ) {
    return "codex";
  }
  if ((record.type === "assistant" || record.type === "user") && isObject(record.message)) {
    return "claude";
  }
  return null;
}

function normalizeAgentKind(value) {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  return normalized === "codex" || normalized === "claude" ? normalized : null;
}

function isClaudeInterruptMessage(message) {
  const content = message.content;
  if (typeof content === "string") {
    return content.trimStart().startsWith(CLAUDE_INTERRUPT_MARKER);
  }
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      isObject(block) &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trimStart().startsWith(CLAUDE_INTERRUPT_MARKER),
  );
}

function isClaudeToolResultMessage(message) {
  return (
    Array.isArray(message.content) &&
    message.content.some((block) => isObject(block) && block.type === "tool_result")
  );
}

function isRealClaudeUserMessage(message) {
  if (isClaudeToolResultMessage(message)) return false;
  const texts = [];
  if (typeof message.content === "string") {
    texts.push(message.content);
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isObject(block) && block.type === "text") texts.push(stringOrEmpty(block.text));
    }
  }
  const text = texts.join("\n").trimStart();
  if (!text) return false;
  if (/^<[a-zA-Z][\w-]*>/.test(text)) return false;
  if (text.startsWith("Caveat:")) return false;
  return !text.startsWith(CLAUDE_INTERRUPT_MARKER);
}

function claudeAssistantText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => isObject(block) && block.type === "text")
    .map((block) => stringOrEmpty(block.text))
    .join("\n");
}

function questionText(input) {
  if (!isObject(input) || !Array.isArray(input.questions)) return "";
  return input.questions
    .map((question) => (isObject(question) ? stringOrEmpty(question.question) : ""))
    .filter(Boolean)
    .join("\n");
}

function claudeSourceRecordId(record, message) {
  return (
    nonEmptyString(record.uuid) ||
    nonEmptyString(message.id) ||
    deterministicEventId([
      "claude-record",
      nonEmptyString(record.sessionId),
      timestampFromRecord(record),
      nullableString(message.stop_reason),
      claudeAssistantText(message),
    ])
  );
}

function fallbackClaudeTurnId(record, message) {
  return deterministicEventId([
    "claude-turn",
    nonEmptyString(record.sessionId),
    timestampFromRecord(record),
    nonEmptyString(message.id),
    nonEmptyString(record.parentUuid),
  ]);
}

function deterministicEventId(parts) {
  const digest = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("base64url");
  return `transcript_${digest}`;
}

function timestampFromRecord(record) {
  if (typeof record.timestamp === "string" && record.timestamp) return record.timestamp;
  return null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
