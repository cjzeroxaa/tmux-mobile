import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
const source = stripTypeScriptTypes(await readFile(new URL('../src/auth.ts', import.meta.url), 'utf8'));
const { signCapability, verifyCapability } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
test('capabilities bind role, session, expiry and signature', async () => {
  const token = await signCapability('test-secret', { sessionId: 'one', role: 'viewer', exp: Date.now() + 10000 });
  assert(await verifyCapability('test-secret', token, 'one', 'viewer'));
  assert(!await verifyCapability('test-secret', token, 'one', 'host'));
  assert(!await verifyCapability('test-secret', token, 'two', 'viewer'));
  assert(!await verifyCapability('wrong-secret', token, 'one', 'viewer'));
  assert(!await verifyCapability('test-secret', token + '.extra', 'one', 'viewer'));
  const expired = await signCapability('test-secret', { sessionId: 'one', role: 'viewer', exp: Date.now() - 1 });
  assert(!await verifyCapability('test-secret', expired, 'one', 'viewer'));
});
