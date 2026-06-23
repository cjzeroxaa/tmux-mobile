const CARD_STAR_KEY_VERSION = "card-star-v1";
const SEP = "\u001F";

export function cardStarKey(fields = {}) {
  const machineId = String(fields.machineId || "local");
  const mux = String(fields.mux || "tmux");
  const sessionName = String(fields.sessionName ?? fields.sessionId ?? "");
  const index = fields.windowIndex ?? fields.index ?? "";
  if (sessionName && index !== "") {
    return [CARD_STAR_KEY_VERSION, machineId, mux, sessionName, String(index)].join(SEP);
  }

  const liveId = String(fields.windowId || fields.paneId || fields.agentSessionId || "");
  return [CARD_STAR_KEY_VERSION, machineId, mux, "live", liveId].join(SEP);
}
