type RelayOptions = {
  secret: () => string;
  userId: () => string;
  writable: (viewer: WebSocket) => boolean;
  connect?: typeof fetch;
};
type Stream = { closed: boolean; abort: AbortController; upstream?: WebSocket; browser?: WebSocket; timer?: ReturnType<typeof setTimeout> };
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export async function asrAssertion(secret: string, userId: string, now = Date.now()) {
  const encoder = new TextEncoder();
  const body = encode(encoder.encode(JSON.stringify({ aud: 'terminal-share-asr', userId, exp: now + 60_000 })));
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode('terminal-share-asr-v1:' + body));
  return `TMaxShareASR ${body}.${encode(new Uint8Array(sig))}`;
}

// ASR uses its own bounded connection. No audio or transcripts enter the
// terminal's binary stream, its snapshot, or Durable Object storage.
export class ShareAsrRelay {
  private streams = new Map<WebSocket, Stream>();
  private options: RelayOptions;
  constructor(options: RelayOptions) { this.options = options; }
  reconcile() {
    for (const [viewer, stream] of this.streams) {
      if (!this.options.writable(viewer)) this.close(viewer, stream, 'Terminal control ended');
    }
  }
  private close(viewer: WebSocket, stream: Stream, reason = 'Dictation ended') {
    if (stream.closed) return;
    stream.closed = true;
    clearTimeout(stream.timer);
    stream.abort.abort();
    if (this.streams.get(viewer) === stream) this.streams.delete(viewer);
    try { stream.browser?.close(1000, reason); } catch {}
    try { stream.upstream?.close(1000, reason); } catch {}
  }
  async accept(viewer: WebSocket): Promise<Response> {
    if (!this.options.writable(viewer)) return new Response('Terminal control required', { status: 403 });
    if (this.streams.has(viewer)) return new Response('Dictation already active', { status: 409 });
    if (!this.options.secret()) return new Response('Dictation unavailable', { status: 503 });
    const stream: Stream = { closed: false, abort: new AbortController() };
    this.streams.set(viewer, stream);
    stream.timer = setTimeout(() => this.close(viewer, stream, 'Dictation connection timed out'), 15_000);
    try {
      const authorization = await asrAssertion(this.options.secret(), this.options.userId());
      const response = await (this.options.connect || fetch)('https://eng.xyznot.com/api/asr/stream', {
        headers: { Upgrade: 'websocket', Authorization: authorization }, signal: stream.abort.signal,
      });
      const upstream = response.webSocket;
      if (!upstream) throw Error('Speech service unavailable');
      stream.upstream = upstream;
      upstream.accept();
      if (stream.closed || !this.options.writable(viewer)) {
        try { upstream.close(1000, 'Terminal control ended'); } catch {}
        this.close(viewer, stream);
        return new Response('Terminal control required', { status: 403 });
      }
      const pair = new WebSocketPair();
      const [client, browser] = Object.values(pair);
      stream.browser = browser;
      browser.accept();
      clearTimeout(stream.timer);
      stream.timer = setTimeout(() => this.close(viewer, stream, 'Dictation time limit reached'), 610_000);
      let bytes = 0;
      browser.addEventListener('message', event => {
        if (stream.closed) return;
        const length = typeof event.data === 'string' ? new TextEncoder().encode(event.data).length : event.data.byteLength;
        bytes += length;
        if (!this.options.writable(viewer) || length > (typeof event.data === 'string' ? 512 : 65536) || bytes > 20 * 1024 * 1024) {
          this.close(viewer, stream, 'Dictation stopped'); return;
        }
        try { upstream.send(event.data); } catch { this.close(viewer, stream); }
      });
      upstream.addEventListener('message', event => {
        if (stream.closed) return;
        if (!this.options.writable(viewer)) { this.close(viewer, stream, 'Terminal control ended'); return; }
        try { browser.send(event.data); } catch { this.close(viewer, stream); }
      });
      for (const socket of [upstream, browser]) {
        socket.addEventListener('close', () => this.close(viewer, stream));
        socket.addEventListener('error', () => this.close(viewer, stream));
      }
      return new Response(null, { status: 101, webSocket: client });
    } catch {
      this.close(viewer, stream);
      return new Response('Live dictation could not connect', { status: 502 });
    }
  }
}
