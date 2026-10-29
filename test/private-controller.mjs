import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import WebSocket from 'ws';
import { readAccessControlFile } from '../lib/access-control.mjs';
import { readPrivateAccess, controllerLoginAllowed, controllerTokenAllowed, controllerMachineAllowed } from '../lib/controller-access.mjs';
import { AGENT_WS_PATH, helloFrame, AGENT_TRANSCRIPT_UPLOAD_PATH } from '../lib/protocol.mjs';
import { DRAFT_UPLOAD_PATH } from '../lib/drafts.mjs';
const config = readAccessControlFile(new URL('../config/access-control.json', import.meta.url));
const policy = config.privateAccess, owner = policy.ownerEmail, mini = policy.existingConnectors[0];
const user = email => ({ userId: email, email });
const strangers = ['xiaohuidexinge@gmail.com', 'huangyuxi1120@gmail.com', 'new@gmail.com', 'engineer@srp.one', 'person@another.example', mini.ownerEmail];
assert.equal(controllerLoginAllowed(policy, user(owner.toUpperCase())), true);
for (const email of strangers) assert.equal(controllerLoginAllowed(policy, user(email)), false);
assert.equal(controllerLoginAllowed(policy, {email:owner,userId:strangers[0]}), false);
assert.equal(controllerTokenAllowed(policy, user(mini.ownerEmail), 'agent'), true);
assert.equal(controllerTokenAllowed(policy, user(mini.ownerEmail), 'session'), false);
assert.equal(controllerMachineAllowed(policy, {owner:user(mini.ownerEmail), agentId:mini.agentId}), true);
assert.equal(controllerMachineAllowed(policy, {owner:user(mini.ownerEmail), agentId:'00000000-0000-4000-8000-000000000001'}), false);
for (const invalid of [null, {}, {ownerEmail:'gmail.com',existingConnectors:[]}, {ownerEmail:owner,existingConnectors:[{ownerEmail:mini.ownerEmail}]}]) assert.throws(() => readPrivateAccess(invalid));
const temp = await mkdtemp(path.join(os.tmpdir(), 'tmax-private-access-'));
const secret = 'private-policy-test-only', sockets = [];
const sign = (type, email) => {
  const body = Buffer.from(JSON.stringify({type, userId:email, email, hd:email.split('@')[1], exp:Math.floor(Date.now()/1000)+600})).toString('base64url');
  return `${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
};
let deviceEmail = owner, logs = '', child;
const google = http.createServer(async (req,res) => {
  const url = new URL(req.url, 'http://test'), chunks=[];
  for await (const chunk of req) chunks.push(chunk);
  const form = new URLSearchParams(Buffer.concat(chunks).toString());
  let result;
  if (url.pathname === '/token') result = {id_token:form.get('code') || form.get('device_code')};
  else if (url.pathname === '/tokeninfo') result = {aud:'test-client',email:url.searchParams.get('id_token'),email_verified:true,hd:'srp.one'};
  else result = {device_code:deviceEmail,user_code:'test',verification_url:'https://example.test',expires_in:600,interval:1};
  res.writeHead(200, {'content-type':'application/json'});res.end(JSON.stringify(result));
});
await new Promise(r=>google.listen(0,'127.0.0.1',r));
const googleUrl = `http://127.0.0.1:${google.address().port}`;
const reservation = http.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
const port = reservation.address().port;await new Promise(r=>reservation.close(r));
const base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function until(fn) { for(let i=0;i<100;i++){if(await fn())return;await sleep(40);}throw new Error('Timed out: '+logs.slice(-3000)); }
const headers = email => ({authorization:`Bearer ${sign('session',email)}`,'content-type':'application/json'});
try {
  child = spawn(process.execPath,['server.mjs','--controller'],{cwd:new URL('../',import.meta.url), env:{...process.env,
    HOST:'127.0.0.1',PORT:String(port),SESSION_SECRET:secret,
    GOOGLE_OAUTH_CLIENT_ID:'test-client',GOOGLE_OAUTH_CLIENT_SECRET:'test',GOOGLE_DEVICE_CLIENT_ID:'test-client',GOOGLE_DEVICE_CLIENT_SECRET:'test',OPENAI_API_KEY:'test',
    GOOGLE_AUTH_URL:googleUrl+'/auth',GOOGLE_TOKEN_URL:googleUrl+'/token',GOOGLE_TOKENINFO_URL:googleUrl+'/tokeninfo',GOOGLE_DEVICE_CODE_URL:googleUrl+'/device',GOOGLE_OAUTH_REDIRECT_URI:base+'/auth/google/callback',
    ALLOW_ALL_GOOGLE_USERS:'1',ALLOWED_GOOGLE_DOMAINS:'gmail.com,srp.one,another.example',ALLOWED_GOOGLE_EMAILS:strangers.join(','),TMUX_MOBILE_ENABLE_LEGACY_AUTH:'1',AGENT_SECRET:'legacy',
    TMUX_MOBILE_ACCESS_CONTROL_FILE:new URL('../config/access-control.json',import.meta.url).pathname,
    TMUX_MOBILE_TRANSCRIPT_ARCHIVE_ENABLED:'0',TMUX_MOBILE_ARTIFACT_STORAGE:'local',TMUX_MOBILE_ARTIFACT_DIR:path.join(temp,'artifacts'),TMUX_MOBILE_PIN_INDEX:'memory',TMUX_MOBILE_COMMENT_INDEX:'memory',
    TMUX_MOBILE_NOTIFICATION_SETTINGS_STORE:'file',TMUX_MOBILE_NOTIFICATION_SETTINGS_CONFIG:path.join(temp,'notifications.json'),TMUX_MOBILE_MCP_STORE:'file',TMUX_MOBILE_MCP_CONFIG:path.join(temp,'mcp.json'),TMUX_MOBILE_SNIPPETS_CONFIG:path.join(temp,'snippets.json'),
  },stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  await until(async()=>{try{return(await fetch(base+'/api/health')).ok;}catch{return false;}});
  for(const email of [owner,...strangers]) {
    const allowed = email === owner;
    for(const header of [headers(email),{cookie:`tmux_mobile_session=${sign('session',email)}`}]) {
      for(const route of ['/auth/me','/api/machines']) assert.equal((await fetch(base+route,{headers:header})).status,allowed?200:401,`${email} ${route}`);
    }
    const handoff = await fetch(base+'/auth/browser-handoff',{method:'POST',headers:headers(email),body:JSON.stringify({returnTo:'/drafts'})});
    assert.equal(handoff.status,allowed?201:401,`handoff ${email}`);
    if(allowed) {
      const response=await fetch(base+(await handoff.json()).handoffUrl,{redirect:'manual'});
      assert.equal(response.status,302);assert.ok(response.headers.get('set-cookie'));
    }
    const login=await fetch(base+'/auth/google/login',{redirect:'manual'});
    const state=new URL(login.headers.get('location')).searchParams.get('state');
    const callback=await fetch(`${base}/auth/google/callback?state=${state}&code=${encodeURIComponent(email)}`,{redirect:'manual'});
    assert.equal(callback.status,allowed?302:403,`fresh OAuth ${email}`);
    if(!allowed)assert.equal(callback.headers.get('set-cookie'),null);
    deviceEmail=email;
    const start=await (await fetch(base+'/auth/device/start',{method:'POST'})).json();
    const poll=await fetch(base+'/auth/device/poll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:start.id})});
    assert.equal(poll.status,allowed?200:403,`new device registration ${email}`);
    const data=await poll.json();if(!allowed)assert.equal(data.token,undefined);
  }
  async function connect(email, agentId, expected) {
    const socket=io(base,{path:AGENT_WS_PATH,transports:['websocket'],reconnection:false,forceNew:true,auth:{token:sign('agent',email)}});sockets.push(socket);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Socket did not settle')),3000);
      const done=fn=>{clearTimeout(timer);try{fn();resolve();}catch(e){reject(e);}};
      socket.on('connect_error',e=>done(()=>{assert.equal(expected,'auth');assert.equal(e.data.code,'auth');}));
      socket.on('disconnect',reason=>{if(expected==='machine')done(()=>assert.equal(reason,'io server disconnect'));});
      socket.on('connect',()=>{
        socket.send(JSON.stringify(helloFrame({agentId,machine:'private-test-'+agentId,os:'test',arch:'test',revision:'test'})));
        if(expected==='ok')done(()=>{});
      });
    });
  }
  const otherId='00000000-0000-4000-8000-000000000001';
  for(const email of strangers.filter(e=>e!==mini.ownerEmail)) {
    await connect(email,otherId,'auth');
    for(const route of [DRAFT_UPLOAD_PATH,AGENT_TRANSCRIPT_UPLOAD_PATH,'/agent/file-upload']) {
      const response=await fetch(base+route,{method:route==='/agent/file-upload'?'GET':'POST',headers:{authorization:`Bearer ${sign('agent',email)}`}});
      assert.equal(response.status,401,`old connector ${email} ${route}`);
    }
  }
  await connect(owner,otherId,'ok');await connect(mini.ownerEmail,mini.agentId,'ok');await connect(mini.ownerEmail,otherId,'machine');
  const deniedDraft=await fetch(base+DRAFT_UPLOAD_PATH+'?context=1',{headers:{authorization:`Bearer ${sign('agent',mini.ownerEmail)}`,'x-agent-id':otherId}});
  assert.equal(deniedDraft.status,403);
  const miniDraft=await fetch(base+DRAFT_UPLOAD_PATH+'?context=1',{headers:{authorization:`Bearer ${sign('agent',mini.ownerEmail)}`,'x-agent-id':mini.agentId}});
  assert.equal(miniDraft.status,200);
  const deniedTranscript=await fetch(base+AGENT_TRANSCRIPT_UPLOAD_PATH,{method:'POST',headers:{authorization:`Bearer ${sign('agent',mini.ownerEmail)}`,'x-agent-id':otherId,'x-machine-id':'new-machine','x-transcript-metadata':Buffer.from('{}').toString('base64url')},body:'{}'});
  assert.equal(deniedTranscript.status,403);
  assert.equal((await fetch(base+'/agent/file-upload',{headers:{'x-agent-secret':'legacy'}})).status,401);
  await until(async()=> (await (await fetch(base+'/api/machines',{headers:headers(owner)})).json()).length===2);
  const forbiddenAsr = await new Promise((resolve,reject)=>{
    const socket=new WebSocket(base.replace('http:','ws:')+'/api/asr/stream',{headers:headers(strangers[0])});
    socket.on('unexpected-response',(_,res)=>{resolve(res.statusCode);res.resume();socket.terminate();});
    socket.on('error',()=>{});socket.on('open',()=>{socket.close();reject(new Error('Forbidden ASR connection opened'));});
  });
  assert.equal(forbiddenAsr,401);
  console.log('private controller policy: OAuth, device login, old sessions, handoff, connector admission, exact mini exception, uploads, ASR and legacy-secret denial passed');
} finally {
  for(const socket of sockets)socket.disconnect();
  if(child && child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}
  await new Promise(r=>google.close(r));await rm(temp,{recursive:true,force:true});
}
