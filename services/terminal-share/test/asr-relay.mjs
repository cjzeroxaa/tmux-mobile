import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {test} from 'node:test';
const moduleUrl=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const {ShareAsrRelay}=await import(moduleUrl(stripTypeScriptTypes(await readFile(new URL('../src/asr-relay.ts',import.meta.url),'utf8'))));
const {dictationTerminalText}=await import(moduleUrl(stripTypeScriptTypes(await readFile(new URL('../src/dictation-input.ts',import.meta.url),'utf8'))));
class Socket extends EventTarget{
  readyState=1;messages=[];closed=false;
  accept(){}
  send(data){this.messages.push(data);}
  receive(data){this.dispatchEvent(new MessageEvent('message',{data}));}
  close(){if(this.closed)return;this.closed=true;this.readyState=3;this.dispatchEvent(new Event('close'));}
}
let pair;
const NativeResponse=globalThis.Response;
globalThis.Response=class extends NativeResponse{
  constructor(body,init){super(body,{...init,status:init?.status===101?200:init?.status});if(init?.status===101)Object.defineProperty(this,'status',{value:101});this.webSocket=init?.webSocket;}
};
globalThis.WebSocketPair=class{constructor(){this[0]=new Socket();this[1]=new Socket();pair=this;}};
function fixture(connect){
  let allowed=true;const viewer=new Socket(),upstream=new Socket(),requests=[];
  const relay=new ShareAsrRelay({secret:()=> 'test-secret',userId:()=> 'owner',writable:v=>allowed&&v===viewer,connect:async(...args)=>{requests.push(args);return connect?connect(...args):{webSocket:upstream};}});
  return {relay,viewer,upstream,requests,lock(){allowed=false;relay.reconcile();}};
}
test('read-only and locked viewers cannot open an ASR connection',async()=>{
  const f=fixture();f.lock();assert.equal((await f.relay.accept(f.viewer)).status,403);assert.equal(f.requests.length,0);
});
test('audio/transcripts use a separate connection; duplicate start and lock are enforced',async()=>{
  const f=fixture();assert.equal((await f.relay.accept(f.viewer)).status,101);
  const browser=pair[1];assert.match(f.requests[0][1].headers.Authorization,/^TMaxShareASR /);
  assert.equal(f.requests[0][0],'https://eng.xyznot.com/api/asr/stream');
  assert.equal((await f.relay.accept(f.viewer)).status,409);
  const audio=Uint8Array.of(1,0).buffer;browser.receive(audio);assert.equal(f.upstream.messages[0],audio);
  f.upstream.receive('{"type":"transcript","text":"live words"}');assert.equal(browser.messages.length,1);assert.equal(f.viewer.messages.length,0);
  f.lock();assert(browser.closed&&f.upstream.closed);
  browser.receive(audio);assert.equal(f.upstream.messages.length,1);
});
test('lock during an upstream handshake prevents a late connection from starting',async()=>{
  let resolve;const f=fixture(()=>new Promise(r=>resolve=r));
  const pending=f.relay.accept(f.viewer);while(!resolve)await new Promise(r=>setImmediate(r));
  f.lock();resolve({webSocket:f.upstream});assert.equal((await pending).status,403);assert(f.upstream.closed);
});
test('browser disconnect and oversized audio close the upstream stream',async()=>{
  for(const action of [s=>s.close(),s=>s.receive(new ArrayBuffer(65537))]){
    const f=fixture();await f.relay.accept(f.viewer);action(pair[1]);assert(f.upstream.closed);
  }
});
test('Insert strips terminal control characters and newlines without sending Enter',()=>{
  assert.equal(dictationTerminalText('hello\nworld\r\n\t你好\x03\x1b'), 'hello world 你好');
  assert.equal(dictationTerminalText('保留 existing draft.'),'保留 existing draft.');
});
