type Capability = { sessionId: string; role: 'host' | 'viewer'; exp: number };
const encoder = new TextEncoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decode = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
async function key(secret: string) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function signCapability(secret: string, value: Capability) {
  const body = encode(encoder.encode(JSON.stringify(value)));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(body));
  return `${body}.${encode(new Uint8Array(signature))}`;
}
export async function verifyCapability(secret: string, token: string, sessionId: string, role: string) {
  try {
    if (token.length > 1024) return false;
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra) return false;
    if (!await crypto.subtle.verify('HMAC', await key(secret), decode(signature), encoder.encode(body))) return false;
    const value = JSON.parse(new TextDecoder().decode(decode(body)));
    return value.sessionId === sessionId && value.role === role && Number.isFinite(value.exp) && value.exp > Date.now();
  } catch { return false; }
}
