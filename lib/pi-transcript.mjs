// Compact, serializable projection of Pi's branch graph. Tool payloads and
// reasoning never enter the graph; parent links retain branch identity.
export function appendPiTranscript(previous, jsonl) {
  const state = { nodes: Object.assign(Object.create(null), previous?.nodes || {}), leaf: previous?.leaf || null, name: previous?.name || "" };
  for (const line of String(jsonl).split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row.id !== 'string' || row.type === 'session') continue;
    if (row.type === 'session_info' && typeof row.name === 'string') state.name = row.name;
    const message = row.type === 'message' ? row.message : null;
    let turn = null;
    if (message && ['user', 'assistant'].includes(message.role)) {
      const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
      const terminal = message.role === 'user' || (!blocks.some(b => b?.type === 'toolCall') && !['toolUse', 'error', 'aborted'].includes(message.stopReason));
      const text = blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim();
      if (terminal && text) turn = { role: message.role, text, ...(row.timestamp ? { t: row.timestamp } : {}) };
    }
    state.nodes[row.id] = { parent: row.parentId || null, turn };
    state.leaf = row.id;
  }
  return state;
}

export function piTranscriptTurns(state, leaf = state?.leaf) {
  const turns = [], seen = new Set();
  while (leaf && !seen.has(leaf)) {
    seen.add(leaf);
    const node = state?.nodes?.[leaf];
    if (!node) break;
    if (node.turn) turns.push(node.turn);
    leaf = node.parent;
  }
  return turns.reverse();
}
