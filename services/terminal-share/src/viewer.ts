import { isVisionDevice, visionTextPreview } from '../../../public/vision-input.js';
import { Terminal } from '@xterm/xterm';
import { installTextSelection } from './text-selection';
import { createViewportFollow } from './viewport';
import { installHistoryFill } from './history-fill';
import { installMobileInput } from './mobile-input';
import { InputControl } from './input-control';
import { bindStreamingDictation } from '../../../public/streaming-asr.js';
import { dictationTerminalText } from './dictation-input';
const vision = isVisionDevice();
const status = document.querySelector<HTMLElement>('#status')!;
const note = document.querySelector<HTMLElement>('#note')!;
const control = document.querySelector<HTMLButtonElement>('#control')!;
const controlNotice = document.querySelector<HTMLElement>('#control-notice')!;
const noticeTitle = document.querySelector<HTMLElement>('#control-notice-title')!;
const noticeDetail = document.querySelector<HTMLElement>('#control-notice-detail')!;
const noticeControl = document.querySelector<HTMLButtonElement>('#notice-take-control')!;
const keyboard = document.querySelector<HTMLButtonElement>('#keyboard')!;
const keys = document.querySelector<HTMLElement>('#keys')!;
const reconnect = document.querySelector<HTMLButtonElement>('#reconnect')!;
const lines = document.querySelector('#lines')! as unknown as HTMLSelectElement;
const uploadButton = document.querySelector<HTMLButtonElement>('#upload')!;
const fileInput = document.querySelector<HTMLInputElement>('#files')!;
const uploadStatus = document.querySelector<HTMLElement>('#upload-status')!;
const attachment = document.querySelector<HTMLElement>('#attachment')!;
const filePaths = document.querySelector<HTMLTextAreaElement>('#file-paths')!;
const insertPaths = document.querySelector<HTMLButtonElement>('#insert-paths')!;
const dictationPanel = document.querySelector<HTMLElement>('#dictation')!;
const dictationInput = document.querySelector<HTMLTextAreaElement>('#dictation-input')!;
const dictationButton = document.querySelector<HTMLButtonElement>('#dictation-toggle')!;
const dictationInsert = document.querySelector<HTMLButtonElement>('#dictation-insert')!;
const dictationClear = document.querySelector<HTMLButtonElement>('#dictation-clear')!;
const dictationStatus = document.querySelector<HTMLElement>('#dictation-status')!;
visionTextPreview(dictationInput);
visionTextPreview(filePaths);
let uploading = false;
const uploads = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const dark = matchMedia('(prefers-color-scheme: dark)');
const theme = () => {
  const colors = getComputedStyle(document.documentElement);
  return {
    background: colors.getPropertyValue('--bg').trim(), foreground: colors.getPropertyValue('--fg').trim(), cursor: '#268bd2',
    selectionBackground: colors.getPropertyValue('--selection-bg').trim(),
    selectionForeground: colors.getPropertyValue('--selection-fg').trim(),
    selectionInactiveBackground: colors.getPropertyValue('--selection-inactive-bg').trim(),
  };
};
const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 5000, convertEol: false, disableStdin: true, theme: theme(), fontSize: 14 });
terminal.open(document.querySelector<HTMLElement>('#terminal')!);
const viewport = document.querySelector<HTMLElement>('#viewport')!;
const textSelection = installTextSelection(terminal, viewport);
const follow = createViewportFollow(viewport, terminal, callback => requestAnimationFrame(callback));
const historyFill = installHistoryFill(viewport, terminal, follow.changed);
viewport.addEventListener('scroll', follow.scrolled, { passive: true });
terminal.onScroll(follow.innerScrolled);
viewport.addEventListener('wheel', event => {
  if (event.deltaY < 0) follow.pause();
}, { passive: true });
let scrollTouchY: number | null = null;
viewport.addEventListener('touchstart', event => { scrollTouchY = event.touches[0]?.clientY ?? null; }, { passive: true });
viewport.addEventListener('touchmove', event => {
  const y = event.touches[0]?.clientY;
  if (y !== undefined && scrollTouchY !== null && y > scrollTouchY + 2) follow.pause();
  scrollTouchY = y ?? null;
}, { passive: true });
viewport.addEventListener('keydown', event => {
  if (event.shiftKey && ['PageUp', 'ArrowUp', 'Home'].includes(event.key)) follow.pause();
});
new ResizeObserver(follow.changed).observe(viewport);
new ResizeObserver(follow.changed).observe(document.querySelector<HTMLElement>('#terminal')!);
terminal.textarea!.readOnly = true;
terminal.textarea!.setAttribute('inputmode', 'text');
terminal.textarea!.setAttribute('enterkeyhint', 'enter');
if (vision) { terminal.textarea!.disabled = true; terminal.textarea!.hidden = true; }
dark.addEventListener('change', () => { terminal.options.theme = theme(); historyFill.refresh(); });
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
const inputControl = new InputControl(type => send(type));
try { viewerToken = sessionStorage.getItem(`tmax.share.${sessionId}`) || ''; } catch {}
function stop() {
  generation++;
  request?.abort(); request = null;
  clearTimeout(retry);
  const old = socket;
  socket = null;
  old?.close();
  inputControl.reset();
  setWritable(false);
  control.disabled = true;
  updateControlNotice();
}
function send(type: string, payload: unknown = {}) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, payload }));
}
async function connect() {
  stop();
  if (document.hidden || ended) return;
  if (!sessionId || !capability) { status.textContent = 'Open a share link from T-Max'; return; }
  const current = generation;
  status.textContent = 'Connecting…';
  reconnect.hidden = true;
  const query = new URLSearchParams({ token: capability, viewerToken, lines: lines.value });
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
        terminal.write(data.subarray(1), () => {
          pendingBytes = Math.max(0, pendingBytes - data.length);
          follow.changed();
        });
        return;
      }
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (frame.type === 'upload.result') {
        const pending = uploads.get(frame.payload.requestId);
        if (pending) {
          clearTimeout(pending.timer); uploads.delete(frame.payload.requestId);
          if (frame.payload.error) pending.reject(Error(frame.payload.error));
          else pending.resolve(frame.payload);
        }
      }
      if (frame.type === 'terminal.snapshot') {
        const { size, data } = frame.payload;
        const complete = follow.snapshot();
        terminal.resize(size.cols, size.rows);
        terminal.write(data, complete);
      }
      if (frame.type === 'session.status') {
        attempts = 0;
        const s = frame.payload;
        inputControl.update(s);
        if (s.viewerToken) {
          viewerToken = s.viewerToken;
          try { sessionStorage.setItem(`tmax.share.${sessionId}`, viewerToken); } catch {}
        }
        if (s.terminalSize) terminal.resize(s.terminalSize.cols, s.terminalSize.rows);
        ended = s.state === 'ended' || s.state === 'closed';
        renderControl();
        if (ended) stop();
      }
    };
    ws.onclose = () => { if (socket === ws && current === generation) schedule(); };
    ws.onerror = () => ws.close();
  } catch { if (current === generation) schedule(); }
}
function schedule() {
  inputControl.reset();
  setWritable(false);
  control.disabled = true;
  if (document.hidden || ended) return;
  status.textContent = 'Disconnected';
  reconnect.hidden = false;
  updateControlNotice();
  if (++attempts <= 8) retry = setTimeout(() => void connect(), Math.min(1000 * 2 ** attempts, 15000));
}
function sendInput(value: string) {
  if (textSelection.open || !canWrite || socket?.readyState !== WebSocket.OPEN) return;
  const data = new TextEncoder().encode(value);
  for (let i = 0; i < data.length; i += 32768) {
    const part = data.subarray(i, i + 32768);
    const frame = new Uint8Array(part.length + 1);
    frame[0] = 2; frame.set(part, 1); socket.send(frame);
  }
}
terminal.onData(sendInput);
const mobileInput = navigator.maxTouchPoints > 0
  && !vision ? installMobileInput(terminal.textarea!, terminal.element!, sendInput, () => canWrite)
  : null;
function updateControlNotice() {
  controlNotice.hidden = canWrite || (!inputControl.status && !ended && !inputControl.locked);
  document.body.dataset.control = canWrite ? 'active' : 'none';
  noticeControl.hidden = control.hidden || !inputControl.locked;
  noticeControl.disabled = control.disabled;
  noticeControl.textContent = 'Unlock';
  noticeTitle.textContent = ended ? 'Sharing stopped — input is off' : inputControl.locked ? 'Locked — input is off' : control.hidden ? 'Read-only terminal' : 'Waiting for control — input is off';
  noticeDetail.textContent = inputControl.locked ? 'Unlock to type, use voice input or upload files.' : control.hidden ? 'Typing and voice input will not be sent.' : 'Input turns on automatically when the machine is connected and control is available.';
}
function renderControl() {
  const s = inputControl.status;
  control.hidden = !s?.allowControl || ended;
  control.disabled = socket?.readyState !== WebSocket.OPEN;
  control.textContent = inputControl.locked ? 'Unlock' : 'Lock';
  control.setAttribute('aria-pressed', String(inputControl.locked));
  note.textContent = s?.allowControl ? 'Input is on by default. Lock to pause input. Ctrl + Shift + Enter: lock or unlock. On phones, tap Keyboard. Only one viewer can type at a time.' : 'View-only link. Keyboard input is disabled.';
  setWritable(inputControl.writable);
  status.textContent = ended ? 'Sharing stopped' : !s?.hostConnected ? 'Waiting for machine…' : !s.allowControl ? 'View only' : inputControl.locked ? 'Locked' : canWrite ? 'You have control' : 'Waiting for control…';
}
function setWritable(value: boolean) {
  canWrite = value;
  if (!value) dictation.cancel();
  renderDictation();
  terminal.options.disableStdin = !value;
  // Prevent mobile keyboards/dictation from opening on a read-only terminal.
  // Keep focus available for selection and local history keyboard shortcuts.
  terminal.textarea!.readOnly = !value;
  terminal.textarea!.setAttribute('aria-label', value ? 'Terminal input' : inputControl.locked ? 'Locked terminal — unlock to type' : 'Read-only terminal');
  keyboard.hidden = !value || vision;
  keys.hidden = !value;
  uploadButton.hidden = !value;
  uploadButton.disabled = !value || uploading;
  insertPaths.disabled = !value;
  if (!value) {
    mobileInput?.reset();
    for (const pending of uploads.values()) {
      clearTimeout(pending.timer); pending.reject(Error('Control lost; upload stopped'));
    }
    uploads.clear();
  }
  if (!value) terminal.blur();
  updateControlNotice();
}
function focusKeyboard() {
  if (vision || textSelection.open || !canWrite) return;
  if (document.activeElement === terminal.textarea) return;
  // iOS needs focus inside the tap, after the textarea is writable. Refocus
  // also handles a textarea previously focused while control was pending.
  terminal.blur();
  terminal.focus();
}
keyboard.onclick = focusKeyboard;
let touch: { x: number; y: number } | null = null;
viewport.addEventListener('pointerdown', event => {
  touch = event.pointerType === 'touch' ? { x: event.clientX, y: event.clientY } : null;
});
viewport.addEventListener('pointercancel', () => { touch = null; });
viewport.addEventListener('pointerup', event => {
  const start = touch; touch = null;
  if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 10 && !getSelection()?.toString()) focusKeyboard();
});
const specialKeys: Record<string, string> = { esc: '\x1b', tab: '\t', interrupt: '\x03', eof: '\x04', clear: '\x0c', suspend: '\x1a', home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', enter: '\r' };
keys.addEventListener('pointerdown', event => {
  // Keep the software keyboard open while tapping a special key.
  if ((event.target as Element).closest('button')) event.preventDefault();
});
keys.addEventListener('click', event => {
  const key = (event.target as Element).closest<HTMLButtonElement>('button')?.dataset.key;
  if (key && specialKeys[key]) {
    if (mobileInput && !mobileInput.beforeCommand()) return;
    const value = specialKeys[key];
    sendInput(terminal.modes.applicationCursorKeysMode && ["up", "down", "left", "right", "home", "end"].includes(key) ? value.replace("[", "O") : value);
  }
});
function fitKeyboardViewport() {
  document.body.style.height = `${window.visualViewport?.height ?? window.innerHeight}px`;
}
window.visualViewport?.addEventListener('resize', fitKeyboardViewport);
fitKeyboardViewport();
function toggleControl() {
  if (control.hidden || control.disabled || socket?.readyState !== WebSocket.OPEN) return;
  inputControl.toggle();
  renderControl();
}
control.onclick = toggleControl;
noticeControl.onclick = toggleControl;
control.title = 'Lock or unlock input (Ctrl + Shift + Enter)';
control.setAttribute('aria-keyshortcuts', 'Control+Shift+Enter');
document.addEventListener('keydown', event => {
  if (textSelection.open || event.isComposing || !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.key !== 'Enter') return;
  // Capture before xterm: the shortcut must never submit the terminal prompt.
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!event.repeat) toggleControl();
}, true);
lines.onchange = () => send('terminal.snapshot.request', { lines: Number(lines.value) });
function uploadRequest(type: string, payload: Record<string, unknown>): Promise<any> {
  if (!canWrite || socket?.readyState !== WebSocket.OPEN) return Promise.reject(Error('Terminal input must be unlocked and connected before uploading'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { uploads.delete(requestId); reject(Error('Upload timed out. Check the Connector is updated.')); }, 60_000);
    uploads.set(requestId, { resolve, reject, timer });
    send(type, { ...payload, requestId });
  });
}
async function uploadFiles(files: File[]) {
  if (!files.length || uploading) return;
  if (!canWrite) { uploadStatus.textContent = 'Terminal input must be unlocked and connected before uploading'; return; }
  uploading = true; uploadButton.disabled = true;
  let id = '';
  try {
    for (const file of files) {
      id = crypto.randomUUID();
      uploadStatus.textContent = `Uploading ${file.name}…`;
      await uploadRequest('upload.start', { id, name: file.name, size: file.size });
      for (let offset = 0; offset < file.size; offset += 65536) {
        const bytes = new Uint8Array(await file.slice(offset, offset + 65536).arrayBuffer());
        const data = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
        await uploadRequest('upload.chunk', { id, offset, data });
        uploadStatus.textContent = `Uploading ${file.name} · ${Math.round(Math.min(offset + bytes.length, file.size) / file.size * 100)}%`;
      }
      const saved = await uploadRequest('upload.end', { id });
      filePaths.value += (filePaths.value ? ' ' : '') + "'" + saved.path.replaceAll("'", "'\\''") + "'";
      attachment.hidden = false;
    }
    uploadStatus.textContent = 'Uploaded. Insert the path when ready; Enter is not sent.';
  } catch (error) {
    uploadStatus.textContent = (error as Error).message;
    if (canWrite) send('upload.cancel', { id, requestId: crypto.randomUUID() });
  } finally { uploading = false; uploadButton.disabled = !canWrite; }
}
uploadButton.onclick = () => fileInput.click();
fileInput.onchange = () => { const files = Array.from(fileInput.files || []); fileInput.value = ''; void uploadFiles(files); };
insertPaths.onclick = () => {
  if (!canWrite || !filePaths.value) return;
  terminal.paste(filePaths.value);
  filePaths.value = ''; attachment.hidden = true;
  focusKeyboard();
};
document.querySelector<HTMLButtonElement>('#clear-paths')!.onclick = () => { filePaths.value = ''; attachment.hidden = true; };
viewport.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
viewport.addEventListener('drop', event => {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault(); void uploadFiles(Array.from(event.dataTransfer.files));
});
document.addEventListener('paste', event => {
  if (!event.clipboardData?.files.length) return;
  event.preventDefault(); event.stopImmediatePropagation();
  void uploadFiles(Array.from(event.clipboardData.files));
}, true);
const dictation = bindStreamingDictation({
  button: dictationButton, input: dictationInput, controls: [dictationClear], submitButton: dictationInsert,
  getText: () => dictationInput.value,
  setText: (text: string) => { dictationInput.value = text; },
  setStatus: (text: string) => { dictationStatus.textContent = text; },
  isBlocked: () => !canWrite,
  disableWhenBlocked: true,
  onActive: () => renderDictation(),
  getStreamUrl: () => `/api/session/${sessionId}/asr?${new URLSearchParams({ token: capability, viewerToken })}`,
});
function renderDictation() {
  dictationPanel.hidden = !inputControl.status?.allowControl;
  dictationInput.readOnly = !canWrite || dictation.active;
  dictationInsert.disabled = !canWrite || (!dictation.active && !dictationTerminalText(dictationInput.value).trim());
  dictationClear.disabled = dictation.active || !dictationInput.value;
  dictation.refresh();
}
dictationInput.addEventListener('input', renderDictation);
dictationClear.onclick = () => { dictationInput.value = ''; dictationStatus.textContent = ''; renderDictation(); };
dictationInsert.onclick = () => {
  if (!canWrite) return;
  void dictation.submit(async (value: string) => {
    if (!canWrite) return;
    const text = dictationTerminalText(value);
    if (!text.trim()) return;
    terminal.paste(text);
    dictationInput.value = '';
    dictationStatus.textContent = 'Text inserted · Press Enter separately to submit';
  }).finally(renderDictation);
};
reconnect.onclick = () => { attempts = 0; void connect(); };
document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); status.textContent = 'Paused'; } else { attempts = 0; void connect(); } });
window.addEventListener('pagehide', stop);
void connect();
