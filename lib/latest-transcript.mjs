// Return whole messages, not excerpts, without sending the entire conversation
// to a card that only needs its last prompt and response.
export function latestTranscriptMessages(result) {
  if (!result) return null;
  const turns = Array.isArray(result.turns) ? result.turns : [];
  const user = turns.findLastIndex(turn => turn.role === "user");
  const assistant = turns.findLastIndex(turn => turn.role === "assistant");
  return { ...result, turns: turns.filter((_, index) => index === user || index === assistant) };
}
