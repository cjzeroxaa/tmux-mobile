import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createHub } from '../lib/hub.mjs';
import { createTranscriptArchive } from '../lib/transcript-archive.mjs';
import { createConversationReader, decodeConversation, conversationPrefix } from '../lib/conversation.mjs';
import { conversationUrl } from '../public/conversation-link.mjs';
const raw = rows => [{ bytes: Buffer.from(rows.map(r => JSON.stringify(r)).join('\n')+'\n') }];
const codex = (role,text,phase) => ({type:'response_item',payload:{type:'message',role,phase,content:[{type: role === 'user' ? 'input_text':'output_text',text}]}});
const claude = (role,content,stop_reason) => ({type:role,message:{role,content,stop_reason}});
const long = 'Complete answer '.repeat(10000);
assert.deepEqual(decodeConversation('codex', raw([
 codex('user','# AGENTS.md instructions for /somewhere'),codex('user','Hello'),
 codex('assistant','Looking into it','commentary'),
 {type:'response_item',payload:{type:'function_call',arguments:'SECRET'}},
 codex('assistant',long,'final_answer'),codex('user','Next'),
 codex('assistant','Old progress'),codex('assistant','Old final'),
])), [{role:'user',text:'Hello'},{role:'assistant',text:long.trim()},{role:'user',text:'Next'},{role:'assistant',text:'Old final'}]);
assert.deepEqual(decodeConversation('claude',raw([
 claude('user','Question'),claude('assistant',[{type:'thinking',thinking:'SECRET'},{type:'text',text:'Working'},{type:'tool_use',id:'tool'}],'tool_use'),
 claude('user',[{type:'tool_result',content:'SECRET'}]),
 claude('assistant',[{type:'text',text:'Final **answer**\n```mermaid\ngraph TD; A-->B\n```'}],'end_turn'),
 {isSidechain:true,...claude('assistant','SIDECHAIN','end_turn')},
])), [{role:'user',text:'Question'},{role:'assistant',text:'Final **answer**\n```mermaid\ngraph TD; A-->B\n```'}]);

const objects = new Map(); let gets=0; let lists=0;
const storage = {
 async get(key){gets++;const bytes=objects.get(key);return bytes?{bytes}:null;},
 async put(key,bytes){objects.set(key,Buffer.from(bytes));},
 async listPrefixes(prefix){lists++;return [...new Set([...objects.keys()].filter(k=>k.startsWith(prefix)).map(k=>prefix+k.slice(prefix.length).split('/')[0]+'/'))];},
};
const archive = createTranscriptArchive({storage});
const source = {ownerId:'owner@example.com',machineId:'mac',agentId:'00000000-0000-4000-8000-000000000011'};
const rows=raw(Array.from({length:260},(_,i)=>codex(i%2?'assistant':'user',`Message ${i}`,i%2?'final_answer':undefined)));
const bytes=rows[0].bytes;
const chunk={agentKind:'codex',agentSessionId:'session-1',fileEpoch:'epoch-1',startOffset:0,endOffsetExclusive:bytes.length,firstLineSeq:0,nextLineSeq:260,sha256:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')};
const result=await archive.commitChunk({...source,chunk});
const identity={...source,agentKind:'codex',agentSessionId:'session-1'};
assert.ok(result.manifestKey.startsWith(conversationPrefix(identity)));
const reader=createConversationReader({storage,archive});
gets=0;lists=0;
const results=await Promise.all(Array.from({length:100},()=>reader.read(identity)));
assert.equal(lists,1,'100 simultaneous opens share one archive read');
assert.equal(results[0].turns.length,260,'history is not capped at 200 turns');
const before=gets;
await reader.read(identity);
assert.equal(gets-before,1,'unchanged session reads only its manifest, not every raw chunk');
assert.equal(await reader.read({...identity,agentSessionId:'missing'}),null);
const route=`m:${Buffer.from(source.ownerId).toString('base64url')}:${Buffer.from(source.agentId).toString('base64url')}`;
const server=http.createServer();
const hub=createHub(server,{superAdminEmails:['admin@example.com'],machineShares:[{ownerEmail:source.ownerId,agentId:source.agentId,emails:['friend@example.com'],domains:['team.example']}]});
for (const viewer of [source.ownerId,'admin@example.com','friend@example.com','dev@team.example']) assert.ok(hub.archiveSourceFor(viewer,route),viewer);
for (const viewer of ['stranger@example.com','dev@team.example.evil','fake@elsewhere']) assert.equal(hub.archiveSourceFor(viewer,route),null,viewer);
assert.equal(hub.archiveSourceFor(source.ownerId,'m:bad:bad'),null);
const revoked=createHub(http.createServer(),{machineShares:[]});
assert.equal(revoked.archiveSourceFor('friend@example.com',route),null,'revoked permissions apply without needing a live machine');
hub.shutdown();revoked.shutdown();
const url=new URL(conversationUrl({machineId:route,kind:'codex',agentSessionId:'session-1',paneId:'%2'}),'https://example.com');
assert.equal(url.searchParams.get('sessionId'),'session-1');assert.equal(url.searchParams.has('paneId'),false);
console.log('conversation: decoder, full history, request coalescing, cache, offline access and share revocation passed');
