import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source = stripTypeScriptTypes(await readFile(new URL('../src/history-fill.ts', import.meta.url), 'utf8'));
const { historyRange } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
test('tall viewer uses history to fill spare height without changing 42 host rows', () => {
 const r = historyRange(995,672,42,500,500);
 assert.equal(r.count,20); assert.equal(r.start,480); assert.equal(r.end,500);
 assert.ok(995-(672+r.count*r.cellHeight)<r.cellHeight);
});
test('short viewer has no extra rows and keeps the original viewport position', () => {
 assert.deepEqual(historyRange(360,672,42,500,430),{start:430,end:430,count:0,cellHeight:16});
});
test('history prefix immediately precedes the scrolled screen, without gaps or duplicates', () => {
 const r=historyRange(995,672,42,500,230);
 assert.equal(r.start,210);assert.equal(r.end,230);
});
test('oldest history still fills the viewer using line zero onwards', () => {
 const r=historyRange(995,672,42,500,0);
 assert.equal(r.start,0); assert.equal(r.end,20); assert.equal(r.count,20);
});
test('insufficient history and alternate screen cannot fabricate extra content', () => {
 assert.equal(historyRange(995,672,42,3,3).count,3);
 assert.equal(historyRange(995,672,42,0,0).count,0);
});
