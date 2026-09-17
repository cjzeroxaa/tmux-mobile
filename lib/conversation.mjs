// Read-only dialogue projection of the archived vendor records. No terminal RPCs.
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
export function conversationPrefix(source) {
  const machine = source.agentId || source.machineId;
  return `v1/${hash(source.ownerId)}/${hash(machine)}/${source.agentKind}/${hash(`${source.ownerId}\0${machine}\0${source.agentKind}\0${source.agentSessionId}`)}/`;
}

export function decodeConversation(kind, chunks) {
  const turns = [];
  const seen = new Set();
  let pending = null;
  const flush = () => { if (pending) turns.push(pending); pending = null; };
  for (const chunk of chunks) {
    for (const line of chunk.bytes.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.isSidechain || row.isMeta || row.isCompactSummary) continue;
      const msg = kind === 'codex' ? (row.type === 'response_item' ? row.payload : null) : row.message;
      if (!msg || (kind === 'codex' && msg.type !== 'message')) continue;
      const role = msg.role;
      if (role !== 'user' && role !== 'assistant') continue;
      if (role === 'assistant' && kind === 'codex' && msg.phase !== 'final_answer' && msg.channel !== 'final') {
        // Older Codex logs have no phase. Keep their last response per user turn.
        if (msg.phase || (msg.channel && msg.channel !== 'final')) continue;
      }
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
      if (kind === 'claude' && role === 'assistant' && (msg.stop_reason === 'tool_use' || blocks.some(b => b?.type === 'tool_use'))) { pending = null; continue; }
      if (role === 'user' && blocks.some(b => b?.type === 'tool_result')) continue;
      const text = blocks.filter(b => ['text', 'input_text', 'output_text'].includes(b?.type))
        .map(b => typeof b.text === 'string' ? b.text : '').join('\n').trim();
      if (!text) continue;
      if (role === 'user' && (/^<(?:environment_context|system-reminder|local-command[^>]*|command-name|command-message|instructions|INSTRUCTIONS|turn_aborted|user_instructions|permissions|collaboration_mode)[\s>]/i.test(text) || text.startsWith('# AGENTS.md instructions') || text.startsWith('[Request interrupted by user]') || text.startsWith('Caveat:'))) continue;
      const id = row.uuid || msg.id;
      const dedupKey = id ? `${id}\0${role}\0${text}` : '';
      if (dedupKey && seen.has(dedupKey)) continue;
      if (dedupKey) seen.add(dedupKey);
      const turn = { role, text, ...(row.timestamp ? { t: row.timestamp } : {}) };
      if (role === 'user') { flush(); turns.push(turn); }
      else if (kind === 'codex' && (msg.phase === 'final_answer' || msg.channel === 'final')) { pending = turn; }
      else if (kind === 'claude' && (msg.stop_reason === 'tool_use' || blocks.some(b => b?.type === 'tool_use'))) { pending = null; }
      else { pending = turn; }
    }
  }
  flush();
  return turns;
}

export function createConversationReader({ storage, archive, maxCacheBytes = 32 * 1024 * 1024, timeoutMs = 40_000 }) {
  const cache = new Map();
  const pending = new Map();
  let cacheBytes = 0;
  async function read(source) {
    const prefix = conversationPrefix(source);
    if (pending.has(prefix)) return pending.get(prefix);
    const operation = (async () => {
      const signal = AbortSignal.timeout(timeoutMs);
      const epochs = await withDeadline(storage.listPrefixes(prefix, { signal }), signal);
      const manifests = [];
      for (const epoch of epochs) {
        if (!epoch.startsWith(prefix) || !/^[a-f0-9]{32}\/$/.test(epoch.slice(prefix.length))) continue;
        const key = `${epoch}manifest.json`;
        signal.throwIfAborted();
        const record = await withDeadline(storage.get(key, { signal }), signal);
        if (!record?.bytes) continue;
        const manifest = JSON.parse(record.bytes.toString('utf8'));
        const s = manifest.source;
        if (s?.ownerId !== source.ownerId || (s.agentId || s.machineId) !== (source.agentId || source.machineId) || s.agentKind !== source.agentKind || s.agentSessionId !== source.agentSessionId) throw new Error('Archive source mismatch');
        manifests.push({ key, manifest });
      }
      // A new epoch is a replacement/copy of a transcript, not another session.
      manifests.sort((a,b) => String(b.manifest.updatedAt).localeCompare(String(a.manifest.updatedAt)));
      const latest = manifests[0];
      if (!latest) return null;
      const version = `${latest.key}:${latest.manifest.lastChunk?.id}`;
      if (cache.get(prefix)?.version === version) return cache.get(prefix).value;
      const epoch = await archive.readEpoch(latest.key, { manifest: latest.manifest, signal });
      if (!epoch) return null;
      const value = { kind: source.agentKind, sessionId: source.agentSessionId, updatedAt: epoch.manifest.updatedAt, turns: decodeConversation(source.agentKind, epoch.chunks) };
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (cache.has(prefix)) { cacheBytes -= cache.get(prefix).bytes; cache.delete(prefix); }
      while (cache.size && (cacheBytes + bytes > maxCacheBytes || cache.size >= 16)) {
        const first = cache.keys().next().value; cacheBytes -= cache.get(first).bytes; cache.delete(first);
      }
      if (bytes <= maxCacheBytes) { cache.set(prefix, { version, value, bytes }); cacheBytes += bytes; }
      return value;
    })();
    pending.set(prefix, operation);
    try { return await operation; } finally { pending.delete(prefix); }
  }
  return { read };
}

function withDeadline(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
