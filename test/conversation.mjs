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
// Long histories use a bounded pool, not a serial linked-list network walk.
const manyObjects = new Map();
let active = 0, peak = 0, readCount = 0;
let delayReads = false;
const manyStorage = {
  async put(key, bytes) { manyObjects.set(key, Buffer.from(bytes)); },
  async get(key, { signal } = {}) {
    readCount++; active++; peak = Math.max(peak, active);
    try {
      if (delayReads) await new Promise((resolve, reject) => {
        const timer = setTimeout(done, 3);
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
        function done() { signal?.removeEventListener('abort', abort); resolve(); }
        signal?.addEventListener('abort', abort, { once: true });
      });
      const bytes = manyObjects.get(key); return bytes ? { bytes } : null;
    } finally { active--; }
  },
  async listPrefixes(prefix) { return [...new Set([...manyObjects.keys()].filter(k => k.startsWith(prefix)).map(k => prefix + k.slice(prefix.length).split('/')[0] + '/'))]; },
  async listKeys(prefix) { return [...manyObjects.keys()].filter(k => k.startsWith(prefix)); },
};
const manyArchive = createTranscriptArchive({ storage: manyStorage });
let offset = 0, last;
for (let i = 0; i < 200; i++) {
  const bytes = raw([codex('user', `Question ${i}`), codex('assistant', `Complete reply ${i}`, 'final_answer')])[0].bytes;
  last = await manyArchive.commitChunk({ ...source, chunk: { ...chunk, startOffset: offset,
    endOffsetExclusive: offset + bytes.length, firstLineSeq: i * 2, nextLineSeq: i * 2 + 2,
    previousChunkSha256: last?.sha256 || "",
    sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') } });
  offset += bytes.length;
}
// A failed writer can leave an orphan object. Listing it must not replay it.
const lastMetadata = JSON.parse(manyObjects.get(last.metadataKey));
const orphanKey = last.metadataKey.replace(/-[a-f0-9]{64}\.json$/, '-' + 'f'.repeat(64) + '.json');
manyObjects.set(orphanKey, Buffer.from(JSON.stringify({ ...lastMetadata, metadataKey: orphanKey, key: 'missing-orphan-raw' })));
readCount = 0; peak = 0; delayReads = true;
const manyReader = createConversationReader({ storage: manyStorage, archive: manyArchive });
const longResults = await Promise.all(Array.from({ length: 100 }, () => manyReader.read(identity)));
assert.equal(longResults[0].turns.length, 400);
assert.deepEqual(longResults[0].turns.at(-1), { role: 'assistant', text: 'Complete reply 199' });
assert.ok(peak > 1 && peak <= 16, `bounded parallel reads: ${peak}`);
assert.equal(readCount, 402, '100 opens share one manifest, 201 metadata and 200 raw reads');
assert.equal(active, 0);
const warmBefore = readCount;
await manyReader.read(identity);
assert.equal(readCount - warmBefore, 1);
// Pin the manifest passed to readEpoch even if an append races with replay.
const snapshot = JSON.parse(manyObjects.get(last.manifestKey));
const oldChunks = await manyArchive.readEpoch(last.manifestKey, { manifest: snapshot });
assert.equal(oldChunks.chunks.length, 200);
// Timeout cancels storage work and releases coalescing; a later attempt works.
const timeoutReader = createConversationReader({ storage: manyStorage, archive: manyArchive, timeoutMs: 10 });
await assert.rejects(timeoutReader.read(identity), error => error.name === 'TimeoutError');
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(active, 0, 'no reads keep running after the deadline');
delayReads = false;
assert.equal((await timeoutReader.read(identity)).turns.length, 400);
// Corrupt committed data is still rejected in the parallel path.
const savedRaw = manyObjects.get(lastMetadata.key);
manyObjects.set(lastMetadata.key, Buffer.from('corrupt'));
await assert.rejects(manyArchive.readEpoch(last.manifestKey), /corrupt raw range/);
manyObjects.set(lastMetadata.key, savedRaw);
console.log('conversation: 200 chunks, 100 concurrent opens, <=16 reads, orphan exclusion, timeout recovery and integrity passed');
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
