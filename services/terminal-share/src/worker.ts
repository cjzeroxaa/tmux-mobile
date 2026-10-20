import { TTYSession } from './session-do';
import { signCapability, verifyCapability } from './auth';
export { TTYSession };
type Env = { CREATE_KEY: string; TTY_SESSION: DurableObjectNamespace; ASSETS: Fetcher };
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') return Response.json({ ok: true, service: 'tmax-terminal-share', version: 1 });
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!env.CREATE_KEY) return new Response('Sharing is not configured', { status: 503 });
    if (url.pathname === '/api/session' && request.method === 'POST') {
      if (request.headers.get('authorization') !== `Bearer ${env.CREATE_KEY}`) return new Response('Unauthorized', { status: 401 });
      let options: { allowControl?: boolean; ttlSeconds?: number; temporary?: boolean };
      try { options = JSON.parse(await request.text()); } catch { return new Response('Invalid JSON', { status: 400 }); }
      const ttlSeconds = options?.ttlSeconds ?? 86400;
      const validDuration = options?.temporary === true
        ? Number.isInteger(ttlSeconds) && ttlSeconds >= 600 && ttlSeconds <= 604800
        : [600, 86400, 432000, 604800].includes(ttlSeconds);
      if (!options || !validDuration) return new Response("Choose 10 minutes, 24 hours, 5 days or 7 days", { status: 400 });
      const sessionId = crypto.randomUUID();
      const exp = Date.now() + ttlSeconds * 1000;
      const stub = env.TTY_SESSION.get(env.TTY_SESSION.idFromName(sessionId));
      const response = await stub.fetch('https://session.internal/init', { method: 'POST', body: JSON.stringify({ allowControl: options.allowControl === true, expiresAt: exp }) });
      if (!response.ok) return new Response('Could not create share', { status: 502 });
      const hostToken = await signCapability(env.CREATE_KEY, { sessionId, role: 'host', exp });
      const viewerToken = await signCapability(env.CREATE_KEY, { sessionId, role: 'viewer', exp });
      return Response.json({ sessionId, expiresAt: exp, ttlSeconds, allowControl: options.allowControl === true,
        viewerUrl: `${url.origin}/s/${sessionId}#${viewerToken}`,
        hostWebSocketUrl: `${url.origin.replace('https:', 'wss:').replace('http:', 'ws:')}/api/session/${sessionId}/host?token=${hostToken}`,
        stopUrl: `${url.origin}/api/session/${sessionId}/end?token=${hostToken}`,
      }, { headers: { 'cache-control': 'no-store' } });
    }
    const match = url.pathname.match(/^\/api\/session\/([0-9a-f-]{36})\/(host|viewer|status|end)$/);
    if (!match) return new Response('Not Found', { status: 404 });
    const [, sessionId, action] = match;
    const role = action === 'host' || action === 'end' ? 'host' : 'viewer';
    if (!await verifyCapability(env.CREATE_KEY, url.searchParams.get('token') || '', sessionId, role)) return new Response('Invalid or expired share link', { status: 403 });
    if (action === 'end' && request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (action === 'host' || action === 'viewer') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
    }
    const stub = env.TTY_SESSION.get(env.TTY_SESSION.idFromName(sessionId));
    const target = action === 'status' || action === 'end' ? action : `connect/${action}`;
    const query = new URLSearchParams();
    if (url.searchParams.has('viewerToken')) query.set('viewerToken', url.searchParams.get('viewerToken')!);
    if (url.searchParams.has('lines')) query.set('lines', url.searchParams.get('lines')!);
    return stub.fetch(new Request(`https://session.internal/${target}?${query}`, request));
  },
};
