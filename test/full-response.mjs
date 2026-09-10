import assert from 'node:assert/strict';
import { needsFullResponse, createFullResponseLoader } from '../public/full-response.mjs';
import { latestTranscriptMessages } from '../lib/latest-transcript.mjs';

const full = '完整中文回复'.repeat(2000) + '\n```mermaid\ngraph TD; A-->B;\n```\nLAST_LINE';
const turn = { role: 'assistant', t: '2026-09-10T19:19:30.631Z', text: full };
const transcript = { sessionId: 'reef', turns: [
  { role: 'assistant', text: 'old' }, { role: 'user', text: 'explain REEF', t: 'before' }, turn,
] };
assert.deepEqual(latestTranscriptMessages(transcript).turns, transcript.turns.slice(-2));
assert.equal(latestTranscriptMessages(transcript).turns.at(-1).text, full);
assert.equal(latestTranscriptMessages(null), null);
assert.equal(needsFullResponse({ lastAssistantText: '短回复' }), false);
assert.equal(needsFullResponse({ lastAssistantText: '中'.repeat(1365) }), true);
assert.equal(needsFullResponse({ lastAssistantText: 'x'.repeat(4093) }), true);
assert.equal(needsFullResponse({ lastAssistantText: 'short', lastAssistantTruncated: true }), true);
const agent = { machineId: 'machine-a', mux: 'rmux', paneId: '%72', agentSessionId: 'reef', lastAssistantText: full.slice(0,1500) };
const load = createFullResponseLoader(async(path, options) => {
  assert.ok(path.includes('latest=1')); assert.ok(path.includes('paneId=%2572'));
  assert.equal(options.machineId, 'machine-a'); assert.equal(options.mux, 'rmux');
  return { result: latestTranscriptMessages(transcript) };
});
assert.equal((await load([agent],()=>true))[0].lastAssistantText, full);
const wrong = createFullResponseLoader(async()=>({result:{sessionId:'other',turns:[turn]}}));
assert.match((await wrong([agent],()=>true))[0].fullTextError, /Session changed/);
const failed = createFullResponseLoader(async()=>{throw Error('offline');});
assert.equal((await failed([agent],()=>true))[0].fullTextError, 'offline');
let calls=0, active=0, maximum=0, current=true;
const pending=[];
const slow=createFullResponseLoader(async()=>{calls++;maximum=Math.max(maximum,++active);await new Promise(r=>pending.push(r));active--;return {result:transcript};});
const promise=slow(Array.from({length:20},()=>({...agent})),()=>current);
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
await flush();assert.equal(calls,4);current=false;pending.splice(0).forEach(r=>r());await promise;
assert.equal(maximum,4);assert.equal(calls,4,'leaving list must discard queued reads');
console.log('full response: uncut Unicode/Mermaid, compact latest endpoint, scope, session match, failure, bounded concurrency passed');
