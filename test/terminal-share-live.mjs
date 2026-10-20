import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import WebSocket from 'ws';
import { terminalShare } from '../lib/terminal-share.mjs';
import { localBackend } from '../lib/backend.mjs';
// Manual integration test: creates temporary, isolated tmux panes and short-lived
// shares on our relay. The service credential is read from a private file.
if (!process.env.TMAX_SHARE_CREATE_KEY_FILE) throw Error('Set TMAX_SHARE_CREATE_KEY_FILE to a private service-key file');
const key=readFileSync(process.env.TMAX_SHARE_CREATE_KEY_FILE,'utf8').trim();
const socket='tmax-share-live-'+process.pid;
const dir=mkdtempSync('/tmp/tmax-share-live-');
const tmux=(...args)=>execFileSync('tmux',['-L',socket,...args],{encoding:'utf8'}).trim();
const run=promisify(execFile);
const command=dir+'/tmux';writeFileSync(command,`#!/bin/sh\nexec tmux -L ${socket} "$@"\n`,{mode:0o700});
process.env.TMUX_MOBILE_TMUX_COMMAND=command;
const backend=localBackend;
process.env.TMUX_MOBILE_UPLOAD_DIR = dir + '/uploads';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<100;i++){if(fn())return;await delay(100);}throw Error('Timed out: '+label);}
function viewer(config){
 const token=new URL(config.viewerUrl).hash.slice(1);
 const ws=new WebSocket(`wss://share.xyznot.com/api/session/${config.sessionId}/viewer?token=${token}`);
 const frames=[];const output=[];
 ws.on('error',e=>console.log('viewer transport error',e.message));
 ws.on('message',(data,binary)=>{if(binary)output.push(data.subarray(1));else frames.push(JSON.parse(data.toString()));});
 return {ws,frames,output};
}
let pane,active,ws;
const results=[];
try{
 const rawReader = dir+'/raw.py';
 writeFileSync(rawReader, 'import os,tty\ntty.setraw(0)\nwhile True:\n data=os.read(0,32768)\n os.write(1,b"BYTES:"+data.hex().encode()+b"\\r\\n"+data+b"\\r\\n")\n');
 pane=tmux('new-session','-d','-s','tmax-share-canary','-x','100','-y','30','-P','-F','#{pane_id}',`python3 -u ${rawReader}`);
 const other=tmux('new-window','-t','tmax-share-canary','-P','-F','#{pane_id}','cat');
 const selected=tmux('display-message','-p','-t','tmax-share-canary','#{window_id}');
 for(const allowControl of [false,true]){
  assert.equal((await fetch('https://share.xyznot.com/api/session',{method:'POST'})).status,401);
  const response=await fetch('https://share.xyznot.com/api/session',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({allowControl,ttlSeconds:allowControl?604800:432000})});
  assert.equal(response.status,200);const config=await response.json();active=config;
  assert.equal(config.ttlSeconds,allowControl?604800:432000);
  assert(config.expiresAt>Date.now()+config.ttlSeconds*1000-10000);
  const token=new URL(config.viewerUrl).hash.slice(1);
  assert.equal((await fetch(`https://share.xyznot.com/api/session/${config.sessionId}/status`)).status,403);
  assert.equal((await fetch(`https://share.xyznot.com/api/session/${config.sessionId}/host?token=${token}`)).status,403);
  await terminalShare({action:'start',target:pane,config},backend);
  assert.equal(tmux('list-clients'),'', 'no tmux subscription before a viewer connects');
  let v=viewer(config);ws=v.ws;
  await until(()=>v.frames.some(f=>f.type==='terminal.snapshot'),'initial snapshot');
  assert.equal(tmux('display-message','-p','-t','tmax-share-canary','#{window_id}'),selected,'share does not switch selected window');
  const marker='LIVE_'+(allowControl?'CONTROL':'VIEW')+'_'+Date.now();
  tmux('send-keys','-t',pane,marker,'Enter');
  tmux('send-keys','-t',other,'UNSHARED_PRIVATE_TEXT','Enter');
  await until(()=>Buffer.concat(v.output).toString().includes(marker),'live output');
  assert(!Buffer.concat(v.output).toString().includes('UNSHARED_PRIVATE_TEXT'));
  ws.send(JSON.stringify({type:'control.request',payload:{}}));
  if(allowControl) await until(()=>v.frames.some(f=>f.payload?.canWrite),'control permission');
  else {await delay(500);assert(!v.frames.some(f=>f.payload?.canWrite));}
  const input='BROWSER_INPUT_'+Date.now();ws.send(Buffer.concat([Buffer.from([2]),Buffer.from(input+'\r')]));
  if(allowControl)await until(()=>Buffer.concat(v.output).toString().includes(input),'browser input echoed');
  else{await delay(300);assert(!tmux('capture-pane','-p','-t',pane).includes(input));}
  if(allowControl){
   const keys=Buffer.from('\x1b\t\x03\x1b[A\r\x04\x0c\x1a\x1b[H\x1b[F\x1b[5~\x1b[6~');
   ws.send(Buffer.concat([Buffer.from([2]),keys]));
   await until(()=>Buffer.concat(v.output).toString().includes('BYTES:'+keys.toString('hex')),'ESC Tab Ctrl-C arrow Enter reach raw terminal unchanged');
  }
  const request = async (type, payload) => {
   const requestId=crypto.randomUUID();
   ws.send(JSON.stringify({type,payload:{...payload,requestId}}));
   await until(()=>v.frames.some(f=>f.type==='upload.result'&&f.payload.requestId===requestId),type);
   return v.frames.find(f=>f.type==='upload.result'&&f.payload.requestId===requestId).payload;
  };
  const content=Buffer.alloc(150000,0x5a);
  const start=await request('upload.start',{id:'live-file',name:'../../live-file.bin',size:content.length});
  if(!allowControl) assert.match(start.error,/Take control/);
  else {
   assert(!start.error);
   for(let offset=0;offset<content.length;offset+=65536) {
    const chunk=await request('upload.chunk',{id:'live-file',offset,data:content.subarray(offset,offset+65536).toString('base64')});
    assert(!chunk.error);
   }
   const saved=await request('upload.end',{id:'live-file'});
   assert.equal(saved.path,dir+'/uploads/live-file.bin');
   assert.deepEqual(readFileSync(saved.path),content);
  }
  ws.close(); await until(()=>tmux('list-clients')==='','unsubscribe after viewer closes');
  v=viewer(config);ws=v.ws;await until(()=>v.frames.some(f=>f.type==='terminal.snapshot'),'reconnect snapshot');
  assert(v.frames.find(f=>f.type==='terminal.snapshot').payload.data.includes(marker));
  await terminalShare({action:'stop',target:pane},backend);
  await until(()=>v.frames.some(f=>['ended','closed'].includes(f.payload?.state)),'share revoked');
  const stopped=await fetch(`https://share.xyznot.com/api/session/${config.sessionId}/status?token=${token}`);
  assert(['ended','closed'].includes((await stopped.json()).state));
  ws.close();assert.equal(tmux('display-message','-p','-t',pane,'#{pane_id}'),pane);
  results.push({allowControl,passed:true});console.log('Live share passed:',allowControl?'control':'view only');
 }
 console.log(JSON.stringify({results,time:new Date().toISOString()}));
}finally{
 ws?.close();if(pane)await terminalShare({action:'stop',target:pane},backend).catch(()=>{});
 try{tmux('kill-server');}catch{}rmSync(dir,{recursive:true,force:true});
}
