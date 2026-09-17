// Read-only dialogue projection of the archived vendor records. No terminal RPCs.
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
export function conversationPrefix(source) {
  const machine = source.agentId || source.machineId;
  return `v1/${hash(source.ownerId)}/${hash(machine)}/${source.agentKind}/${hash(`${source.ownerId}\0${machine}\0${source.agentKind}\0${source.agentSessionId}`)}/`;
}

export function decodeConversation(kind, chunks) {
  return dialogueValue(decodeDialogue(kind, chunks));
}
function dialogueValue(state) { return state.pending ? [...state.turns, state.pending] : state.turns; }
function decodeDialogue(kind, chunks, previous) {
  const turns = previous ? [...previous.turns] : [];
  const seen = new Set(previous?.seen || []);
  let pending = previous?.pending || null;
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
  return { turns, pending, seen: [...seen] };
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
      let previous = cache.get(prefix);
      if (previous?.version === version) return previous.value;
      const projectionKey = latest.key.replace(/manifest\.json$/, 'conversation-v1.json');
      if (!previous || previous.manifestKey !== latest.key) {
        // A compact, disposable projection survives process restarts. Original
        // vendor archives remain authoritative; a missing cache rebuilds once.
        const stored = await withDeadline(storage.get(projectionKey, { signal }), signal);
        try {
          const candidate = stored?.bytes ? JSON.parse(stored.bytes.toString('utf8')) : null;
          if (candidate?.schema === 1 && candidate.manifestKey === latest.key &&
              Array.isArray(candidate.state?.turns) && Array.isArray(candidate.state?.seen) &&
              candidate.checkpoint?.metadataKey?.startsWith(latest.key.replace(/manifest\.json$/, 'ranges/')) &&
              Number.isSafeInteger(candidate.checkpoint.committedOffset) &&
              candidate.checkpoint.committedOffset <= latest.manifest.committedOffset) previous = candidate;
          else previous = null;
        } catch { previous = null; }
      }
      let state;
      if (previous?.version === version) state = previous.state;
      else {
        let epoch;
        try { epoch = await archive.readEpoch(latest.key, { manifest: latest.manifest, signal, after: previous?.checkpoint }); }
        catch (error) {
          if (!previous || error.code !== 'transcript_archive_chain_invalid') throw error;
          // An epoch replacement or invalid cache is recoverable from raw data.
          previous = null;
          epoch = await archive.readEpoch(latest.key, { manifest: latest.manifest, signal });
        }
        if (!epoch) return null;
        state = decodeDialogue(source.agentKind, epoch.chunks, previous?.state);
      }
      const value = { kind: source.agentKind, sessionId: source.agentSessionId, updatedAt: latest.manifest.updatedAt, turns: dialogueValue(state) };
      const entry = { schema: 1, manifestKey: latest.key, version, state,
        checkpoint: { metadataKey: latest.manifest.lastChunk?.metadataKey,
          committedOffset: latest.manifest.committedOffset, nextLineSeq: latest.manifest.nextLineSeq } };
      const serialized = JSON.stringify(entry);
      const bytes = Buffer.byteLength(serialized) + Buffer.byteLength(JSON.stringify(value));
      if (previous?.version !== version && bytes <= maxCacheBytes) {
        // Best-effort cache only: a cache-write outage must not fail an otherwise
        // successful history read, and cannot block it indefinitely.
        try { await withDeadline(storage.put(projectionKey, Buffer.from(serialized), { overwrite: true, contentType: 'application/json' }), AbortSignal.timeout(2_000)); }
        catch { /* The next open can rebuild from the immutable raw archive. */ }
      }
      if (cache.has(prefix)) { cacheBytes -= cache.get(prefix).bytes; cache.delete(prefix); }
      while (cache.size && (cacheBytes + bytes > maxCacheBytes || cache.size >= 16)) {
        const first = cache.keys().next().value; cacheBytes -= cache.get(first).bytes; cache.delete(first);
      }
      if (bytes <= maxCacheBytes) { cache.set(prefix, { ...entry, value, bytes }); cacheBytes += bytes; }
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
