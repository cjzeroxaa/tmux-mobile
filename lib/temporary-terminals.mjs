import { randomUUID } from 'node:crypto';
import { isNoMuxServerError } from './window-runtime.mjs';

const locks = new Map();
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const option = '@tmax_temporary_terminal';
const format = `#{${option}}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{session_created}\t#{pane_current_command}`;
const fail = (message, status = 400) => Object.assign(Error(message), { status });

export function temporaryTerminals(backend, startShare) {
  const tmux = args => backend.tmux(args, { mux: 'tmux' });
  async function list() {
    let output;
    try { output = await tmux(['list-panes', '-a', '-F', format]); }
    catch (error) { if (isNoMuxServerError(error)) return []; throw error; }
    return output.trim().split('\n').flatMap(line => {
      const [tag, sessionId, windowId, paneId, created, command] = line.split('\t');
      const [id, originalPane] = (tag || '').split(':');
      if (!idPattern.test(id) || originalPane !== paneId) return [];
      return [{ id, sessionId, windowId, paneId, createdAt: Number(created) * 1000, command }];
    }).sort((a, b) => b.createdAt - a.createdAt);
  }
  async function find(id) {
    const terminal = (await list()).find(row => row.id === id);
    if (!terminal) throw fail('Temporary terminal no longer exists', 404);
    return terminal;
  }
  async function run(action, id = randomUUID(), durationSeconds = 600) {
    if (!idPattern.test(id)) throw fail('Invalid temporary terminal');
    if (!['create', 'open', 'extend', 'stop', 'close'].includes(action)) throw fail('Invalid temporary terminal action');
    if (![600, 3600].includes(durationSeconds)) throw fail('Choose 10 minutes or 1 hour');
    const key = `${backend.metadataCacheKey?.() || backend.muxCommand('tmux')}:${id}`;
    const previous = locks.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      let terminal = (await list()).find(row => row.id === id);
      if (action === 'create' && !terminal) {
        // Explicitly bypass any tmux default-command that launches an agent.
        // Login + interactive shell loads the machine user's normal aliases.
        const output = await tmux([
          'new-session', '-d', '-s', `tmax-shell-${id}`, '-n', 'temporary-shell',
          '-c', '#{HOME}', '-x', '100', '-y', '30', '-P', '-F', '#{window_id}\t#{pane_id}',
          'exec "${SHELL:-/bin/bash}" -il',
        ]);
        const [windowId, paneId] = output.trim().split('\t');
        if (!/^@\d+$/.test(windowId) || !/^%\d+$/.test(paneId)) throw fail('Could not identify the new shell', 502);
        try { await tmux(['set-option', '-w', '-t', windowId, option, `${id}:${paneId}`]); }
        catch (error) { await tmux(['kill-window', '-t', windowId]).catch(() => {}); throw error; }
        terminal = await find(id);
      }
      terminal ||= await find(id);
      if (action === 'close' || action === 'stop') {
        await backend.terminalShare({ action: 'stop', target: terminal.paneId });
        // Re-resolve the marked window, never a caller-supplied tmux ID.
        if (action === 'close') await tmux(['kill-window', '-t', (await find(id)).windowId]);
        return { terminal: action === 'close' ? null : terminal, share: null };
      }
      const current = await backend.terminalShare({ action: 'status', target: terminal.paneId });
      if (action !== 'extend' && current.viewerUrl && current.allowControl && current.expiresAt > Date.now()) {
        return { terminal, share: current };
      }
      const expiry = (action === 'extend' ? Math.max(Date.now(), current.expiresAt || 0) : Date.now()) + durationSeconds * 1000;
      const ttlSeconds = Math.ceil((expiry - Date.now()) / 1000);
      if (ttlSeconds > 7 * 86400) throw fail('A sharing link cannot exceed 7 days');
      const share = await startShare({ target: terminal.paneId, ttlSeconds, allowControl: true, temporary: true });
      return { terminal, share };
    });
    locks.set(key, task);
    try { return await task; } finally { if (locks.get(key) === task) locks.delete(key); }
  }
  return { list, run };
}
