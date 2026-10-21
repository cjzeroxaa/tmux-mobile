import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source=stripTypeScriptTypes(await readFile(new URL('../src/text-selection.ts',import.meta.url),'utf8'));
const {terminalPlainText}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
function buffer(lines){return {length:lines.length,getLine(i){const l=lines[i];return l&&{isWrapped:l.wrapped,translateToString(trim){return trim?l.text.trimEnd():l.text}}}};}
test('joins wrapped lines while preserving actual line breaks and Chinese text',()=>{
 assert.equal(terminalPlainText(buffer([{text:'hello ',wrapped:false},{text:'世界',wrapped:true},{text:'next',wrapped:false}])), 'hello 世界\nnext');
});
test('exports every loaded line, not just the current terminal screen',()=>{
 const lines=Array.from({length:5000},(_,i)=>({text:`line${i}`,wrapped:false}));
 const result=terminalPlainText(buffer(lines));assert.equal(result.split('\n').length,5000);assert.ok(result.endsWith('line4999'));
});
