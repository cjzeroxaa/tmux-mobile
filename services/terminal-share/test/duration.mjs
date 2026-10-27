import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
const url = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const auth = url(stripTypeScriptTypes(await readFile(new URL('../src/auth.ts', import.meta.url), 'utf8')));
const source = (await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8'))
  .replace("import { TTYSession } from './session-do';", 'class TTYSession {}')
  .replace("'./auth'", JSON.stringify(auth));
const { default: worker } = await import(url(stripTypeScriptTypes(source)));
const { verifyCapability, signCapability } = await import(auth);
function fixture() {
  const calls = [];
  const env = { CREATE_KEY: 'test-only', TTY_SESSION: {
    idFromName: id => id, get: id => ({ async fetch(target, options) {
      calls.push({ id, target, body: JSON.parse(options.body) });
      return Response.json({ ok: true });
    } }),
  } };
  const create = body => worker.fetch(new Request('https://share.xyznot.com/api/session', {
    method: 'POST', headers: { authorization: 'Bearer test-only' }, body: JSON.stringify(body),
  }), env);
  return { create, calls };
}
test('default/5/7-day shares bind the same deadline to DO and signed capabilities', async () => {
  for (const ttlSeconds of [600, undefined, 432000, 604800]) {
    const { create, calls } = fixture(); const before = Date.now();
    const response = await create({ ttlSeconds, allowControl: true });
    assert.equal(response.status, 200); const share = await response.json();
    assert.equal(share.ttlSeconds, ttlSeconds ?? 86400);
    assert(share.expiresAt >= before + share.ttlSeconds * 1000);
    assert(share.expiresAt <= Date.now() + share.ttlSeconds * 1000);
    assert.equal(calls[0].body.expiresAt, share.expiresAt);
    const token = new URL(share.viewerUrl).hash.slice(1);
    assert.equal(JSON.parse(Buffer.from(token.split('.')[0], 'base64url')).exp, share.expiresAt);
    assert(await verifyCapability('test-only', token, share.sessionId, 'viewer'));
  }
});
test('invalid durations never allocate a Durable Object', async () => {
  const { create, calls } = fixture();
  for (const body of [null, {ttlSeconds: 0}, {ttlSeconds: -1}, {ttlSeconds: 691200}, {ttlSeconds: '604800'}]) {
    assert.equal((await create(body)).status, 400);
  }
  assert.equal(calls.length, 0);
});

test('temporary renewals allow bounded additive durations and bind expiry', async () => {
  const { create, calls } = fixture();
  for (const ttlSeconds of [600, 1199, 1800, 3600, 4199]) {
    const response = await create({temporary: true, ttlSeconds, allowControl: true});
    assert.equal(response.status, 200);
    const share = await response.json();
    assert.equal(share.ttlSeconds, ttlSeconds);
    assert.equal(calls.at(-1).body.expiresAt, share.expiresAt);
    assert(await verifyCapability('test-only', new URL(share.viewerUrl).hash.slice(1), share.sessionId, 'viewer'));
  }
  for (const ttlSeconds of [0, 599, 600.5, 604801, '600']) {
    assert.equal((await create({temporary: true, ttlSeconds})).status, 400);
  }
});

test('ASR upgrades require the viewer capability and exact share origin', async () => {
  const id=crypto.randomUUID(), secret='test-only';
  const token=await signCapability(secret,{sessionId:id,role:'viewer',exp:Date.now()+60000});
  const calls=[];
  const env={CREATE_KEY:secret,TTY_SESSION:{idFromName:id=>id,get:()=>({fetch:async req=>{calls.push(req);return new Response('allowed')}})}};
  const url=`https://share.xyznot.com/api/session/${id}/asr?token=${token}&viewerToken=active-viewer`;
  for(const origin of [undefined,'https://attacker.invalid']) {
    const headers={upgrade:'websocket',...(origin?{origin}:{})};
    assert.equal((await worker.fetch(new Request(url,{headers}),env)).status,403);
  }
  const headers={upgrade:'websocket',origin:'https://share.xyznot.com'};
  assert.equal((await worker.fetch(new Request(url.replace(token,'invalid'),{headers}),env)).status,403);
  assert.equal((await worker.fetch(new Request(url,{headers}),env)).status,200);
  assert.equal(calls.length,1);
  assert.equal(new URL(calls[0].url).pathname,'/asr');
  assert.equal(new URL(calls[0].url).searchParams.get('viewerToken'),'active-viewer');
});

test('share ASR ownership stays in private session state', async () => {
  const { create, calls } = fixture();
  const response = await create({allowControl:true,asrUserId:'owner@example.test'});
  const publicConfig = await response.json();
  assert.equal(calls[0].body.asrUserId,'owner@example.test');
  assert.equal(publicConfig.asrUserId,undefined);
});
