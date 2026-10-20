import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { TerminalShareUpload } from './terminal-share-upload.mjs';

// A control-mode client does not steal the user's terminal, resize it, or use
// pipe-pane (which could overwrite an existing logger). Only the selected pane's
// bytes leave this machine. There is no capture/inventory polling.
export function decodeTmuxOutput(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && /^[0-7]{3}$/.test(text.slice(i + 1, i + 4))) {
      bytes.push(parseInt(text.slice(i + 1, i + 4), 8)); i += 3;
    } else bytes.push(text.charCodeAt(i));
  }
  return Buffer.from(bytes);
}

export class TmuxShareStream {
  constructor({ command = 'tmux', target, sessionTarget, onOutput, onResize, onExit }) {
    this.target = target; this.onOutput = onOutput; this.onResize = onResize; this.onExit = onExit;
    this.closed = false; this.pending = []; this.current = null; this.chain = Promise.resolve();
    this.child = spawn(command, ['-C', 'attach-session', '-t', sessionTarget || target, '-f', 'ignore-size'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('latin1');
    this.child.stderr.resume();
    this.ready = new Promise((resolve, reject) => { this.initial = { resolve, reject }; });
    this.ready.catch(() => {});
    this.timer = setTimeout(() => this.close(Error('Terminal attach timed out')), 10000);
    this.child.on('error', e => this.close(e));
    this.child.on('exit', () => this.close(Error('Terminal disconnected')));
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    void (async () => {
      // Await each line so snapshot replies are delivered before later output.
      for await (const line of lines) await this.line(line);
    })().catch(e => this.close(e));
  }
  async line(line) {
    if (this.closed) return;
    if (line.startsWith('%begin ')) { this.current = []; return; }
    if (line.startsWith('%end ') || line.startsWith('%error ')) {
      const result = (this.current || []).join('\n'); this.current = null;
      const task = this.initial || this.pending.shift();
      this.initial = null;
      clearTimeout(this.timer);
      if (line.startsWith('%error ')) task?.reject(Error(result || 'tmux command failed'));
      else task?.resolve(result);
      return;
    }
    if (this.current) { this.current.push(line); return; }
    const output = line.match(/^%output (%\d+) (.*)$/);
    if (output?.[1] === this.target) this.onOutput(decodeTmuxOutput(output[2]));
    if (line.startsWith('%layout-change ')) this.onResize?.();
    if (line.startsWith('%exit')) this.close(Error('Terminal disconnected'));
  }
  request(command) {
    const task = this.chain.then(async () => {
      await this.ready;
      if (this.closed) throw Error('Terminal disconnected');
      return new Promise((resolve, reject) => {
        this.pending.push({ resolve, reject });
        this.timer = setTimeout(() => this.close(Error('Terminal command timed out')), 10000);
        this.child.stdin.write(command + '\n');
      });
    });
    this.chain = task.catch(() => {});
    return task;
  }
  async snapshot(lines = 500) {
    const row = await this.request(`display-message -p -t ${this.target} '#{pane_width},#{pane_height},#{cursor_x},#{cursor_y},#{cursor_flag}'`);
    const [cols, rows, x, y, visible] = row.split(',').map(Number);
    if (!cols || !rows) throw Error('Shared pane is no longer available');
    const count = [100, 500, 1000, 2000, 5000].includes(lines) ? lines : 500;
    const captured = await this.request(`capture-pane -p -e -S -${count} -t ${this.target}`);
    const data = '\x1bc\x1b[?7l' + Buffer.from(captured, 'latin1').toString('utf8').replaceAll('\n', '\r\n') + `\x1b[?7h\x1b[${y + 1};${x + 1}H\x1b[?25${visible ? 'h' : 'l'}`;
    return { size: { cols, rows }, data };
  }
  close(error = Error('Sharing stopped')) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.initial?.reject(error); this.initial = null;
    for (const task of this.pending.splice(0)) task.reject(error);
    this.child.stdin.destroy();
    this.child.kill();
    this.onExit?.(error);
  }
}

const shares = new Map();
const starts = new Map();
function publicShare(share) {
  return { ok: true, target: share.target, shareId: share.sessionId, viewerUrl: share.viewerUrl, expiresAt: share.expiresAt, allowControl: share.allowControl, ttlSeconds: share.ttlSeconds || 86400 };
}
export async function terminalShare({ action = 'status', target, config }, backend) {
  if (!/^%\d+$/.test(String(target))) throw Error('Terminal share target must be a pane id');
  const key = `${backend.muxCommand('tmux')}:${target}`;
  if (action === 'status') return shares.has(key) ? publicShare(shares.get(key)) : { ok: true, active: false };
  if (action === 'stop') {
    await starts.get(key)?.catch(() => {});
    const share = shares.get(key);
    if (share) await share.stop();
    return { ok: true, active: false };
  }
  if (action !== 'start') throw Error('Invalid share action');
  if (starts.has(key)) throw Error('A share is already starting for this pane');
  const starting = (async () => {
    if (shares.has(key)) await shares.get(key).stop();
    validateShareConfig(config);
    const paneInfo = await backend.tmux(['display-message', '-p', '-t', target, '#{session_id}'], { mux: 'tmux' });
    const sessionTarget = paneInfo.trim();
    if (!/^\$\d+$/.test(sessionTarget)) throw Error('Invalid tmux session');
    const share = new TerminalShare({ ...config, target, sessionTarget, backend, onStop: () => { if (shares.get(key) === share) shares.delete(key); } });
    shares.set(key, share);
    try { await share.start(); return publicShare(share); }
    catch (error) { await share.stop(); throw error; }
  })();
  starts.set(key, starting);
  try { return await starting; } finally { starts.delete(key); }
}
export function validateShareConfig(config) {
  if (!config || !Number.isFinite(config.expiresAt) || config.expiresAt <= Date.now() || config.expiresAt > Date.now() + 7 * 86400000 + 60000) throw Error('Invalid share expiry');
  const host = new URL(config.hostWebSocketUrl);
  const stop = new URL(config.stopUrl);
  const viewer = new URL(config.viewerUrl);
  if (host.protocol !== 'wss:' || host.hostname !== 'share.xyznot.com' || stop.origin !== 'https://share.xyznot.com' || viewer.origin !== stop.origin) throw Error('Invalid terminal share service');
  if (!/^[0-9a-f-]{36}$/.test(config.sessionId) || host.pathname !== `/api/session/${config.sessionId}/host` || stop.pathname !== `/api/session/${config.sessionId}/end`) throw Error('Invalid share session');
}
export function stopTerminalShares() { for (const share of shares.values()) void share.stop(); }

class TerminalShare {
  constructor(config) {
    Object.assign(this, config);
    this.closed = false; this.socket = null; this.stream = null;
    this.reconnectTimer = null; this.expiryTimer = null; this.offlineSince = 0;
    this.inputChain = Promise.resolve(); this.queuedInput = 0; this.snapshotChain = Promise.resolve();
    this.upload = new TerminalShareUpload(this.backend);
    this.uploadChain = Promise.resolve();
  }
  async start() {
    this.expiryTimer = setTimeout(() => void this.stop(), Math.max(1, this.expiresAt - Date.now()));
    await this.connect();
  }
  connect() {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.hostWebSocketUrl, { handshakeTimeout: 10000, maxPayload: 1024 * 1024 });
      this.socket = ws;
      let lastPong = Date.now();
      const heartbeat = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastPong > 45000) ws.terminate();
        else ws.ping();
      }, 20000);
      heartbeat.unref();
      ws.on('pong', () => { lastPong = Date.now(); });
      ws.on('open', () => { this.offlineSince = 0; resolve(); });
      ws.on('error', () => reject(Error('Could not connect to terminal sharing service')));
      ws.on('message', (data, binary) => {
        if (this.closed || this.socket !== ws) return;
        if (binary) { if (this.allowControl && data[0] === 2) this.input(data.subarray(1)); return; }
        let frame; try { frame = JSON.parse(data.toString()); } catch { return; }
        if (frame.type === 'session.status') {
          if (this.controllerId !== frame.payload.controllerViewerId) this.upload.cancel();
          this.controllerId = frame.payload.controllerViewerId;
          if (['ended', 'closed'].includes(frame.payload.state)) { void this.stop(); return; }
          if (frame.payload.viewerCount > 0) this.ensureStream(); else this.pause();
        }
        if (frame.type === 'terminal.profile.request') this.send('terminal.profile', { platform: 'unix' });
        if (frame.type === 'terminal.snapshot.request') {
          this.ensureStream(); void this.snapshot(frame.payload.requestId, frame.payload.lines);
        }
        if (frame.type?.startsWith('upload.')) {
          const payload = frame.payload;
          const run = async () => {
            if (this.closed || this.socket !== ws || !this.allowControl || payload.viewerId !== this.controllerId) return;
            try {
              const result = await this.upload.handle(frame.type, payload);
              this.send('upload.result', { requestId: payload.requestId, viewerId: payload.viewerId, ...result });
            } catch (error) {
              this.upload.cancel();
              this.send('upload.result', { requestId: payload.requestId, viewerId: payload.viewerId, error: error.message });
            }
          };
          this.uploadChain = this.uploadChain.then(run).catch(() => {});
        }
        if (frame.type === 'control.request') this.send(this.allowControl ? 'control.approve' : 'control.reject', frame.payload);
        if (frame.type === 'session.ended') void this.stop();
      });
      ws.on('close', () => {
        clearInterval(heartbeat);
        reject(Error('Terminal sharing connection closed'));
        if (this.socket !== ws) return;
        this.pause();
        if (this.closed) return;
        this.offlineSince ||= Date.now();
        if (Date.now() - this.offlineSince > 150000) { void this.stop(); return; }
        this.reconnectTimer = setTimeout(() => { void this.connect().catch(() => {}); }, 2000);
      });
    });
  }
  send(type, payload) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type, payload }));
  }
  ensureStream() {
    if (this.stream || this.closed) return;
    const stream = new TmuxShareStream({ command: this.backend.muxCommand('tmux'), target: this.target, sessionTarget: this.sessionTarget,
      onResize: () => {
        clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => { if (this.stream === stream) this.send('terminal.refresh', {}); }, 100);
      },
      onOutput: data => {
        if (this.stream !== stream || this.socket?.readyState !== WebSocket.OPEN) return;
        if (this.socket.bufferedAmount > 1024 * 1024) { this.socket.close(1013, 'Slow connection'); return; }
        this.socket.send(Buffer.concat([Buffer.from([1]), data]));
      },
      onExit: () => { if (this.stream === stream && !this.closed) void this.stop(); },
    });
    this.stream = stream;
  }
  snapshot(requestId, lines) {
    const stream = this.stream;
    const task = this.snapshotChain.then(async () => {
      if (!stream || this.stream !== stream || this.closed) return;
      const snapshot = await stream.snapshot(lines);
      if (this.stream !== stream || this.closed) return;
      this.send('terminal.size', snapshot.size);
      if (requestId) this.send('terminal.snapshot', { ...snapshot, requestId });
      else if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(Buffer.concat([Buffer.from([1]), Buffer.from(snapshot.data)]));
    });
    this.snapshotChain = task.catch(() => { if (this.stream === stream) void this.stop(); });
    return this.snapshotChain;
  }
  input(data) {
    if (!this.stream || !data.length) return;
    const controllerId = this.controllerId;
    if (this.queuedInput + data.length > 256 * 1024) { this.socket?.close(1009, 'Input queue full'); return; }
    this.queuedInput += data.length;
    this.inputChain = this.inputChain.then(async () => {
      // Hex arguments preserve literal bytes, including Ctrl-C, without allowing
      // shell or tmux command injection. Chunk below OS command-line limits.
      for (let i = 0; i < data.length && !this.closed && this.stream && this.controllerId === controllerId; i += 512) {
        await this.backend.tmux(['send-keys', '-H', '-t', this.target, ...Array.from(data.subarray(i, i + 512), b => b.toString(16).padStart(2, '0'))], { mux: 'tmux', timeout: 10000 });
      }
    }).catch(() => { void this.stop(); }).finally(() => { this.queuedInput -= data.length; });
  }
  pause() { this.upload.cancel(); clearTimeout(this.resizeTimer); const stream = this.stream; this.stream = null; stream?.close(); }
  async stop() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.expiryTimer); clearTimeout(this.reconnectTimer);
    this.pause(); this.send('session.end', {}); this.socket?.close(); this.onStop();
    try { await fetch(this.stopUrl, { method: 'POST', signal: AbortSignal.timeout(5000) }); } catch {}
  }
}
