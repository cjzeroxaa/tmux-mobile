import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { appendPiTranscript, piTranscriptTurns } from '../lib/pi-transcript.mjs';
import { installPiExtension, readPiSession, isPiCommand, piTranscriptRoot, PI_EXTENSION_SOURCE } from '../lib/pi-runtime.mjs';
import { discoverTranscriptFiles } from '../lib/transcript-discovery.mjs';
import { readLocalAgentTranscript, resetAgentTranscriptSnapshotCache, agentTranscriptSnapshotMetrics } from '../lib/backend.mjs';
import { createTranscriptEventDecoder } from '../lib/transcript-events.mjs';
import { createTranscriptArchive } from '../lib/transcript-archive.mjs';
import { createAgentTranscriptPublisher, createFileTranscriptStateStore } from '../lib/transcript-publisher.mjs';
import { createConversationReader, decodeConversation } from '../lib/conversation.mjs';
import { detectCommandCenterAgentType } from '../lib/window-metadata.mjs';
import { conversationUrl } from '../public/conversation-link.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'tmax-pi-test-'));
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const msg = (id, parentId, role, text, extra = {}) => ({ type:'message', id, parentId, timestamp:'2026-10-09T12:00:00Z', message:{role, content:[{type:'text',text}], ...(role === 'assistant' ? {stopReason:'stop'} : {}), ...extra} });
const long = 'Complete Pi response '.repeat(20000) + '\n```mermaid\ngraph TD; A-->B\n```';
const initial = [{type:'session', version:3, id:'test-session', cwd:temp}, msg('u1',null,'user','Question'),
 msg('tool','u1','assistant','hidden progress',{stopReason:'toolUse',content:[{type:'text',text:'hidden progress'},{type:'toolCall',name:'bash'}]}),
 msg('result','tool','toolResult','hidden output'), msg('answer','result','assistant',long),
 {type:'session_info',id:'name',parentId:'answer',name:'Pi integration'}, msg('oldq','name','user','Old branch'),msg('olda','oldq','assistant','Old answer')];
const branch = [msg('newq','name','user','New branch'),msg('newa','newq','assistant','New answer')];
try {
  assert.equal(isPiCommand('node /opt/@earendil-works/pi-coding-agent/dist/cli.js'), true);
  assert.equal(isPiCommand('/opt/pi --model claude-sonnet'), true);
  assert.equal(isPiCommand('node /opt/pilot/main.js'), false);
  assert.equal(isPiCommand('cat pi-notes.md'), false);
  assert.equal(detectCommandCenterAgentType(['node /opt/@mariozechner/pi-coding-agent/dist/cli.js']), 'pi');
  assert.match(conversationUrl({kind:'pi',machineId:'m',agentSessionId:'s'}), /kind=pi/);
  const state = appendPiTranscript(appendPiTranscript(null,jsonl(initial)),jsonl(branch));
  assert.deepEqual(piTranscriptTurns(state).map(t=>t.text), ['Question',long,'New branch','New answer']);
  assert.deepEqual(piTranscriptTurns(state,'olda').map(t=>t.text), ['Question',long,'Old branch','Old answer']);
  assert.deepEqual(decodeConversation('pi',[{bytes:Buffer.from(jsonl(initial))},{bytes:Buffer.from(jsonl(branch))}]).map(t=>t.text), ['Question',long,'New branch','New answer']);
  assert.equal(state.name,'Pi integration');
  const file = path.join(temp,'session.jsonl');
  await writeFile(file,jsonl(initial));
  resetAgentTranscriptSnapshotCache();
  assert.equal((await readLocalAgentTranscript('pi',file)).turns[1].text,long);
  const before=agentTranscriptSnapshotMetrics();
  await appendFile(file,jsonl(branch));
  const latest = await readLocalAgentTranscript('pi',file);
  assert.equal(latest.turns.at(-1).text,'New answer');
  const after=agentTranscriptSnapshotMetrics();
  assert.equal(after.rebuilds,before.rebuilds,'append does not reread the whole transcript');
  assert.equal(after.appends,1);
  assert.ok(after.bytesRead-before.bytesRead <= 4096 + Buffer.byteLength(jsonl(branch)),'only delta and boundary bytes read');
  assert.equal((await readLocalAgentTranscript('pi',file,{leafId:'olda'})).turns.at(-1).text,'Old answer','live leaf switches without file mutation');
  assert.equal((await readLocalAgentTranscript('pi',file,{leafId:null})).turns.length,0);
  await appendFile(file,'{"type":"message"');
  assert.equal((await readLocalAgentTranscript('pi',file)).turns.at(-1).text,'New answer','incomplete tail ignored');

  const home = path.join(temp,'home');
  const root=piTranscriptRoot({},home);
  await mkdir(path.join(root,'--project--'),{recursive:true});
  const sourcePath=path.join(root,'--project--','2026-10-09T12-00-00-000Z_custom-session.jsonl');
  await writeFile(sourcePath,jsonl(initial));
  assert.equal((await discoverTranscriptFiles({roots:[{kind:'pi',root}]}))[0].agentSessionId,'custom-session');
  const extension = await installPiExtension({home,env:{}});
  assert.equal(await readFile(extension,'utf8'),PI_EXTENSION_SOURCE);
  assert.equal(await installPiExtension({home,env:{}}),extension,'idempotent install');
  const registry=path.join(home,'.config','tmux-mobile','pi-sessions');
  await mkdir(registry,{recursive:true});
  await writeFile(path.join(registry,'101.json'),JSON.stringify({pid:101,sessionId:'first',transcriptPath:sourcePath,state:'idle'}));
  await writeFile(path.join(registry,'102.json'),JSON.stringify({pid:102,sessionId:'second',transcriptPath:sourcePath,state:'working'}));
  assert.equal((await readPiSession(101,{home,env:{},verifyProcess:async()=>true})).sessionId,'first');
  assert.equal((await readPiSession(102,{home,env:{},verifyProcess:async()=>true})).sessionId,'second');
  await writeFile(path.join(registry,'104.json'),JSON.stringify({pid:104,sessionId:'pending',transcriptPath:path.join(root,'--project--','not-written.jsonl'),state:'idle'}));
  assert.equal((await readPiSession(104,{home,env:{},verifyProcess:async()=>true})).state,'idle','new Pi session remains visible before JSONL exists');
  assert.equal(await readPiSession(101,{home,env:{},verifyProcess:async()=>false}),null,'stale PID record rejected');
  await writeFile(path.join(registry,'103.json'),JSON.stringify({pid:103,sessionId:'outside',transcriptPath:file}));
  assert.equal(await readPiSession(103,{home,env:{},verifyProcess:async()=>true}),null,'outside transcript root rejected');

  // Run the real extension event handlers against an isolated runtime context.
  const handlers=new Map(); let record;
  const fsMock={mkdirSync(){},writeFileSync(_file,bytes){record=JSON.parse(bytes);},renameSync(){},unlinkSync(){record=null;}};
  const extensionBody=PI_EXTENSION_SOURCE.replace(/^import .*;$/mg,'').replace('export default function(pi)','(function(pi)') + ')';
  const factory=vm.runInNewContext(extensionBody,{fs:fsMock,path,os:{homedir:()=>home},process:{pid:303,uptime:()=>10},Date});
  factory({on:(name,fn)=>handlers.set(name,fn),getThinkingLevel:()=> 'high'});
  let sessionId='one', leaf='answer';
  const ctx={cwd:temp,model:{id:'test-model'},sessionManager:{getSessionId:()=>sessionId,getSessionFile:()=>sourcePath,getLeafId:()=>leaf,getSessionName:()=> 'Named session'}};
  handlers.get('session_start')({},ctx);assert.equal(record.state,'idle');
  handlers.get('agent_start')({},ctx);assert.equal(record.state,'working');
  handlers.get('agent_end')({},ctx);assert.equal(record.state,'idle');
  sessionId='two';leaf='newa';handlers.get('session_start')({},ctx);assert.equal(record.sessionId,'two');assert.equal(record.leafId,'newa');
  handlers.get('session_shutdown')();assert.equal(record,null);

  const decoder=createTranscriptEventDecoder({agentKind:'pi',sessionId:'s'});
  assert.equal(decoder.push(initial[2]).length,0,'tool call not turn completion');
  assert.equal(decoder.push(initial[4])[0].type,'agent.turn.completed');
  assert.equal(decoder.push(initial[4]).length,0,'completion replay deduplicated');
  assert.equal(decoder.push(msg('abort','u1','assistant','',{stopReason:'aborted'}))[0].type,'agent.turn.aborted');

  const objects=new Map(); let gets=0, lists=0;
  const storage={async get(key){gets++;const bytes=objects.get(key);return bytes?{bytes}:null;},async put(key,bytes){objects.set(key,Buffer.from(bytes));},async listPrefixes(prefix){lists++;return [...new Set([...objects.keys()].filter(k=>k.startsWith(prefix)).map(k=>prefix+k.slice(prefix.length).split('/')[0]+'/'))];}};
  const archive=createTranscriptArchive({storage});
  const source={ownerId:'test',machineId:'test',agentId:'test'};
  const identity={...source,agentKind:'pi',agentSessionId:'s'};
  let bytes=Buffer.from(jsonl(initial)), uploads=0;
  const publisher=createAgentTranscriptPublisher({stateStore:createFileTranscriptStateStore({filePath:path.join(temp,'cursor.json')}),stat:async()=>({dev:1,ino:1,size:bytes.length,isFile:()=>true}),readRange:async(_f,start,end)=>bytes.subarray(start,end),realpathImpl:async p=>p,createFileEpoch:()=> 'e',setIntervalImpl:()=>({unref(){}}),clearIntervalImpl(){},uploadChunk:async chunk=>{uploads++;await archive.commitChunk({...source,chunk});return {ack:true,chunkId:chunk.chunkId};}});
  // Use the default allowed root with injected file I/O; no real user file is modified.
  await publisher.observeAgents([{kind:'pi',agentSessionId:'s',transcriptPath:path.join(piTranscriptRoot(),'test.jsonl')}]);
  publisher.setEnabled(true);await publisher.syncNow();
  await publisher.syncNow();await publisher.syncNow();
  const initialUploads=uploads;assert.ok(initialUploads > 0);
  await publisher.syncNow();assert.equal(uploads,initialUploads,'unchanged file is never reuploaded');
  bytes=Buffer.concat([bytes,Buffer.from(jsonl(branch))]);await publisher.syncNow();assert.equal(uploads,initialUploads+1);
  const reader=createConversationReader({storage,archive});
  lists=0;
  const values=await Promise.all(Array.from({length:100},()=>reader.read(identity)));
  assert.equal(lists,1,'100 opens share one archive read');
  assert.equal(values[0].turns.at(-1).text,'New answer');
  const oldGets=gets;await reader.read(identity);assert.equal(gets-oldGets,1,'unchanged history only checks manifest');
  publisher.stop();
  console.log('Pi agent integration tests passed');
} finally {await rm(temp,{recursive:true,force:true});}
