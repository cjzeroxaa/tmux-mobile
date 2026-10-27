import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { authenticateShareAsr } from '../lib/terminal-share-asr-auth.mjs';
import { attachStreamingAsr } from '../lib/streaming-asr.mjs';
const source = stripTypeScriptTypes(await readFile(new URL('../services/terminal-share/src/asr-relay.ts', import.meta.url), 'utf8'));
const { asrAssertion } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const secret = 'test-controller-secret';
const key = createHmac('sha256', secret).update('tmax-terminal-share-v1').digest('hex');
const now = Date.now();
const authorization = await asrAssertion(key, 'owner@example.test', now);
const authenticate = headers => authenticateShareAsr({ headers }, secret, now);
assert.deepEqual(authenticate({ authorization }), { userId: 'owner@example.test' });
for (const headers of [{}, { authorization: authorization + '.extra' }, { authorization: authorization.slice(0,-5)+'wrong' }, { authorization, origin:'https://share.xyznot.com' }, { authorization:'Bearer '+authorization.slice(13) }]) assert.equal(authenticate(headers), null);
assert.equal(authenticateShareAsr({headers:{authorization}}, 'wrong-secret', now), null);
assert.equal(authenticateShareAsr({headers:{authorization}}, '', now), null);
assert.equal(authenticate({authorization:await asrAssertion(key,'owner@example.test',now-61_000)}),null);
assert.equal(authenticate({authorization:await asrAssertion(key,'owner@example.test',now+120_000)}),null);
assert.equal(authenticate({authorization:await asrAssertion(key,'')}),null);
assert.equal(authenticate({authorization:await asrAssertion(key,'a'.repeat(255))}),null);
class Speech extends EventEmitter {
  start(){queueMicrotask(()=>this.emit('ready'));}
  audio(){this.emit('transcript',{text:'Shared speech',final:false});}
  finish(){this.emit('transcript',{text:'Shared speech.',final:true});this.emit('done');}
  close(){}
}
const server=http.createServer();
const wss=attachStreamingAsr(server,{authenticate:req=>authenticateShareAsr(req,secret),origin:()=> 'https://eng.xyznot.com',secret,createSession:()=>new Speech()});
server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`ws://127.0.0.1:${server.address().port}/api/asr/stream`;
let ws;
try{
  ws=new WebSocket(base,{headers:{authorization}});
  await once(ws,'open');
  const frames=[];ws.on('message',data=>frames.push(JSON.parse(data)));
  ws.send(JSON.stringify({type:'start',format:'pcm16'}));
  await once(ws,'message');assert.equal(frames[0].type,'ready');
  ws.send(Buffer.from([0,0,1,0]));await once(ws,'message');
  assert.equal(frames.at(-1).text,'Shared speech');
  ws.send(JSON.stringify({type:'finish'}));await once(ws,'close');
  assert(frames.some(v=>v.final&&v.text==='Shared speech.'));
  assert.equal(frames.at(-1).type,'done');
}finally{ws?.terminate();for(const client of wss.clients)client.terminate();wss.close();server.close();}
console.log('Share ASR: Worker/Controller assertions, expiry, scope, origin rejection and authenticated streaming passed.');
