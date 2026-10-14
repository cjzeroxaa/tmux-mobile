import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTROLLER_ORIGIN as next, LEGACY_CONTROLLER_ORIGIN as old, canonicalControllerUrl, controllerIdentityKey, controllerOAuthRedirectUri } from '../lib/controller-origin.mjs';
import { agentIdForController, agentAuthState } from '../lib/agent.mjs';
assert.equal(canonicalControllerUrl(old + '/connector/update.mjs'), next + '/connector/update.mjs');
assert.equal(controllerIdentityKey(next), old);
assert.equal(controllerIdentityKey('https://private.example'), 'https://private.example');
assert.equal(controllerIdentityKey(next + '.evil.example'), next + '.evil.example');
for (const origin of [next, old]) assert.equal(controllerOAuthRedirectUri(origin, old + '/auth/google/callback'), origin + '/auth/google/callback');
assert.equal(controllerOAuthRedirectUri('http://localhost:3737', 'https://test.example/callback'), 'https://test.example/callback');
const dir = mkdtempSync(path.join(os.tmpdir(), 'controller-migration-'));
const saved = process.env.TMUX_MOBILE_AGENT_CONFIG;
try {
  process.env.TMUX_MOBILE_AGENT_CONFIG = path.join(dir, 'agent.json');
  const id = 'a3d3bbeb-2782-4222-8e34-b09f8d14d89f';
  const config = { controllers: { [old]: { agentId: id, token: 'test-token' }, 'https://private.example': { agentId: '00ef8f6b-3fce-47b0-9e4e-c7b97cbbff8c' } } };
  writeFileSync(process.env.TMUX_MOBILE_AGENT_CONFIG, JSON.stringify(config));
  assert.equal(agentIdForController(next), id, 'new domain retains machine ID and archive keys');
  assert.equal(agentIdForController(old), id, 'old domain remains usable');
  assert.equal(agentAuthState(next).hasAuth, true, 'no device login required after migration');
  assert.deepEqual(JSON.parse(readFileSync(process.env.TMUX_MOBILE_AGENT_CONFIG)), config, 'credentials and other servers are not rewritten');
} finally {
  if (saved === undefined) delete process.env.TMUX_MOBILE_AGENT_CONFIG; else process.env.TMUX_MOBILE_AGENT_CONFIG = saved;
  rmSync(dir, { recursive: true, force: true });
}
console.log('controller migration identity and OAuth tests passed');
