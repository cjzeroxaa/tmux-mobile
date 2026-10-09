import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const processChecks = new Map();
async function currentProcess(pid, startedAt) {
  if (!Number.isFinite(startedAt)) return false;
  const key = `${pid}:${startedAt}`;
  const cached = processChecks.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.valid;
  let valid = false;
  try {
    const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 2000 });
    valid = Math.abs(Date.parse(stdout.trim()) - startedAt) < 2500;
  } catch {}
  if (processChecks.size > 512) processChecks.clear();
  processChecks.set(key, { at: Date.now(), valid });
  return valid;
}

export function piAgentDir(env = process.env, home = os.homedir()) {
  const value = env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent');
  return value.startsWith('~/') ? path.join(home, value.slice(2)) : path.resolve(value);
}
export function piTranscriptRoot(env = process.env, home = os.homedir()) {
  const value = env.TMUX_MOBILE_PI_TRANSCRIPT_ROOT || env.PI_CODING_AGENT_SESSION_DIR || path.join(piAgentDir(env, home), 'sessions');
  return value.startsWith('~/') ? path.join(home, value.slice(2)) : path.resolve(value);
}
export function isPiCommand(command) {
  return /(?:^|[\s/])pi(?:\.(?:m?js|cjs))?(?=\s|$)/i.test(String(command || '')) || /\/(?:@earendil-works|@mariozechner)\/pi-coding-agent\//.test(String(command || ''));
}

// Pi loads this managed extension on startup or /reload. It has no network,
// timer or model calls. Atomic local writes identify simultaneous sessions.
export const PI_EXTENSION_SOURCE = `// Managed by T-Max Connector. No network or timers.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export default function(pi) {
  const dir = path.join(os.homedir(), '.config', 'tmux-mobile', 'pi-sessions');
  const file = path.join(dir, process.pid + '.json');
  let working = false;
  const publish = (_event, ctx) => {
    try {
      const sm = ctx.sessionManager;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const value = { pid: process.pid, processStartedAt: Date.now() - process.uptime() * 1000,
        sessionId: sm.getSessionId(), transcriptPath: sm.getSessionFile() || '',
        leafId: sm.getLeafId(), name: sm.getSessionName() || '', cwd: ctx.cwd,
        state: working ? 'working' : 'idle', model: ctx.model?.id || '', effort: pi.getThinkingLevel?.() || '', updatedAt: Date.now() };
      fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } catch { /* Observability must never interrupt Pi. */ }
  };
  pi.on('session_start', (e, ctx) => { working = false; publish(e, ctx); });
  pi.on('agent_start', (e, ctx) => { working = true; publish(e, ctx); });
  pi.on('agent_end', (e, ctx) => { working = false; publish(e, ctx); });
  for (const name of ['message_end', 'session_tree', 'session_compact', 'session_info_changed']) pi.on(name, publish);
  pi.on('session_shutdown', () => { try { fs.unlinkSync(file); } catch {} });
}
`;
export async function installPiExtension({ env = process.env, home = os.homedir() } = {}) {
  const dir = path.join(piAgentDir(env, home), 'extensions');
  const file = path.join(dir, 'tmax-connector.js');
  await mkdir(dir, { recursive: true });
  let existing;
  try { existing = await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (existing === PI_EXTENSION_SOURCE) return file;
  if (existing && !existing.startsWith('// Managed by T-Max Connector.')) throw new Error('Refusing to overwrite unmanaged Pi extension');
  await writeFile(file, PI_EXTENSION_SOURCE, { mode: 0o600 });
  return file;
}
export async function readPiSession(pid, { home = os.homedir(), env = process.env, verifyProcess = currentProcess } = {}) {
  try {
    const record = JSON.parse(await readFile(path.join(home, '.config', 'tmux-mobile', 'pi-sessions', `${Number(pid)}.json`), 'utf8'));
    if (record.pid !== Number(pid) || !record.sessionId || !await verifyProcess(Number(pid), record.processStartedAt)) return null;
    // Callers select only a live Pi process. Validate the root before reading
    // or publishing any path supplied by an extension.
    if (record.transcriptPath) {
      const root = await realpath(piTranscriptRoot(env, home));
      let target;
      try { target = await realpath(record.transcriptPath); }
      catch (error) {
        if (error.code !== 'ENOENT') return null;
        const parent = await realpath(path.dirname(record.transcriptPath));
        const pending = path.join(parent, path.basename(record.transcriptPath));
        if (!pending.startsWith(root + path.sep) || !pending.endsWith('.jsonl')) return null;
        // Pi creates the JSONL lazily, after the first conversation message.
        record.transcriptPath = '';
      }
      if (target) {
        if (!target.startsWith(root + path.sep) || !target.endsWith('.jsonl')) return null;
        record.transcriptPath = target;
      }
    }
    return record;
  } catch { return null; }
}
