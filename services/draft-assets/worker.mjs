// Private media delivery. Only the Controller signs read URLs, after Draft authorization.
const validPath=/^\/[a-f0-9]{64}\/[a-f0-9]{64}\.[a-z0-9]{1,10}$/;
const deny=(message,status)=>new Response(message,{status,headers:{'cache-control':'private, no-store','access-control-allow-origin':'*'}});
export async function validToken(path,token,key,now=Date.now()) {
  const [expiration,signature,...extra]=String(token||'').split('.');
  const exp=Number(expiration);
  if(!key||extra.length||!/^\d{10}$/.test(expiration)||!Number.isSafeInteger(exp)||exp<=Math.floor(now/1000)||exp>Math.floor(now/1000)+86460||!/^[-_A-Za-z0-9]{43}$/.test(signature||'')) return false;
  try {
    const raw=Uint8Array.from(atob(signature.replaceAll('-','+').replaceAll('_','/')+'='),c=>c.charCodeAt(0));
    const signing=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    return crypto.subtle.verify('HMAC',signing,raw,new TextEncoder().encode(`${path}\n${exp}`));
  } catch { return false; }
}
export function parseRange(value,size) {
  if(!value) return null;
  const m=value.match(/^bytes=(\d*)-(\d*)$/);
  if(!m||(!m[1]&&!m[2])) return false;
  let start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2]));
  let end=m[1]?(m[2]?Math.min(Number(m[2]),size-1):size-1):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start) return false;
  return {offset:start,length:end-start+1};
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(url.pathname==='/api/health') return Response.json({ok:true,service:'tmax-draft-assets',version:1});
    if(!validPath.test(url.pathname)) return deny('Not found',404);
    if(!['GET','HEAD','OPTIONS'].includes(request.method)) return deny('Method not allowed',405);
    if(!await validToken(url.pathname,url.searchParams.get('token'),env.READ_KEY)) return deny('Invalid or expired asset link',403);
    // Sandboxed Drafts have an opaque origin. The token authorizes this exact object;
    // wildcard CORS exposes no cookies or bucket credentials.
    const headers=new Headers({'access-control-allow-origin':'*','access-control-allow-methods':'GET, HEAD, OPTIONS','access-control-allow-headers':'Range, If-Range','access-control-expose-headers':'Content-Length, Content-Range, Accept-Ranges, ETag','cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'referrer-policy':'no-referrer','accept-ranges':'bytes'});
    if(request.method==='OPTIONS') return new Response(null,{status:204,headers});
    const key=url.pathname.slice(1), meta=await env.ASSETS.head(key);
    if(!meta) return deny('Not found',404);
    meta.writeHttpMetadata(headers); headers.set('etag',meta.httpEtag);
    headers.set('cache-control','private, no-store');
    headers.set('content-length',String(meta.size));
    if(request.method==='HEAD') return new Response(null,{headers});
    const requested=request.headers.get('range');
    const ifRange=request.headers.get('if-range');
    const range=parseRange(ifRange&&ifRange!==meta.httpEtag?null:requested,meta.size);
    if(range===false) { headers.set('content-range',`bytes */${meta.size}`);headers.delete('content-length');return new Response(null,{status:416,headers}); }
    const object=await env.ASSETS.get(key,range?{range}:undefined);
    if(!object) return deny('Not found',404);
    if(range) {
      headers.set('content-range',`bytes ${range.offset}-${range.offset+range.length-1}/${meta.size}`);
      headers.set('content-length',String(range.length));
    }
    return new Response(object.body,{status:range?206:200,headers});
  }
};
