import { Terminal } from '@xterm/xterm';
const status = document.querySelector<HTMLElement>('#status')!;
const note = document.querySelector<HTMLElement>('#note')!;
const control = document.querySelector<HTMLButtonElement>('#control')!;
const reconnect = document.querySelector<HTMLButtonElement>('#reconnect')!;
const dark = matchMedia('(prefers-color-scheme: dark)');
const theme = () => ({ background: dark.matches ? '#002b36' : '#fdf6e3', foreground: dark.matches ? '#93a1a1' : '#586e75', cursor: '#268bd2' });
const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 2000, convertEol: false, theme: theme(), fontSize: 14 });
terminal.open(document.querySelector<HTMLElement>('#terminal')!);
dark.addEventListener('change', () => { terminal.options.theme = theme(); });
const sessionId = location.pathname.match(/^\/s\/([0-9a-f-]{36})$/)?.[1];
const capability = location.hash.slice(1);
let socket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let canWrite = false;
let ended = false;
let attempts = 0;
let pendingBytes = 0;
let viewerToken = '';
let request: AbortController | null = null;
try { viewerToken = sessionStorage.getItem(`tmax.share.${sessionId}`) || ''; } catch {}
function stop() {
  generation++;
  request?.abort(); request = null;
  clearTimeout(retry);
  const old = socket;
  socket = null;
  old?.close();
  canWrite = false;
  control.disabled = true;
}
function send(type: string) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, payload: {} }));
}
async function connect() {
  stop();
  if (document.hidden || ended) return;
  if (!sessionId || !capability) { status.textContent = 'Open a share link from T-Max'; return; }
  const current = generation;
  status.textContent = 'Connecting…';
  reconnect.hidden = true;
  const query = new URLSearchParams({ token: capability, viewerToken });
  request = new AbortController();
  try {
    const check = await fetch(`/api/session/${sessionId}/status?${query}`, { cache: 'no-store', signal: request.signal });
    if (current !== generation) return;
    if (check.status === 403 || check.status === 410) { ended = true; status.textContent = 'Share expired or stopped'; return; }
    if (!check.ok) throw Error('Share unavailable');
    const state = await check.json() as { state: string };
    if (current !== generation) return;
    if (state.state === 'ended' || state.state === 'closed') { ended = true; status.textContent = 'Sharing stopped'; return; }
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/session/${sessionId}/viewer?${query}`);
    socket = ws;
    ws.binaryType = 'arraybuffer';
    ws.onmessage = event => {
      if (socket !== ws || current !== generation) return;
      if (typeof event.data !== 'string') {
        const data = new Uint8Array(event.data);
        if (data[0] !== 1) return;
        pendingBytes += data.length;
        if (pendingBytes > 4 * 1024 * 1024) { stop(); pendingBytes = 0; void connect(); return; }
        terminal.write(data.subarray(1), () => { pendingBytes = Math.max(0, pendingBytes - data.length); });
        return;
      }
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (frame.type === 'terminal.snapshot') {
        const { size, data } = frame.payload;
        terminal.resize(size.cols, size.rows);
        terminal.write(data);
      }
      if (frame.type === 'session.status') {
        attempts = 0;
        const s = frame.payload;
        canWrite = Boolean(s.canWrite);
        terminal.options.disableStdin = !canWrite;
        if (s.viewerToken) {
          viewerToken = s.viewerToken;
          try { sessionStorage.setItem(`tmax.share.${sessionId}`, viewerToken); } catch {}
        }
        if (s.terminalSize) terminal.resize(s.terminalSize.cols, s.terminalSize.rows);
        ended = s.state === 'ended' || s.state === 'closed';
        status.textContent = ended ? 'Sharing stopped' : !s.hostConnected ? 'Waiting for machine…' : canWrite ? 'You have control' : 'View only';
        control.hidden = !s.allowControl || ended;
        control.disabled = !s.hostConnected || Boolean(s.controllerViewerId && !canWrite) || Boolean(s.pendingControlRequest);
        control.textContent = canWrite ? 'Release control' : 'Take control';
        note.textContent = s.allowControl ? 'The owner enabled control for this link. Only one viewer can type at a time.' : 'View-only link. Keyboard input is disabled.';
        if (ended) stop();
      }
    };
    ws.onclose = () => { if (socket === ws && current === generation) schedule(); };
    ws.onerror = () => ws.close();
  } catch { if (current === generation) schedule(); }
}
function schedule() {
  canWrite = false;
  control.disabled = true;
  if (document.hidden || ended) return;
  status.textContent = 'Disconnected';
  reconnect.hidden = false;
  if (++attempts <= 8) retry = setTimeout(() => void connect(), Math.min(1000 * 2 ** attempts, 15000));
}
terminal.onData(value => {
  if (!canWrite || socket?.readyState !== WebSocket.OPEN) return;
  const data = new TextEncoder().encode(value);
  for (let i = 0; i < data.length; i += 32768) {
    const part = data.subarray(i, i + 32768);
    const frame = new Uint8Array(part.length + 1);
    frame[0] = 2; frame.set(part, 1); socket.send(frame);
  }
});
control.onclick = () => { send(canWrite ? 'control.release' : 'control.request'); terminal.focus(); };
reconnect.onclick = () => { attempts = 0; void connect(); };
document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); status.textContent = 'Paused'; } else { attempts = 0; void connect(); } });
window.addEventListener('pagehide', stop);
void connect();
