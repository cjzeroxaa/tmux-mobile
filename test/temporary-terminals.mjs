import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { temporaryTerminals } from '../lib/temporary-terminals.mjs';
const exec = promisify(execFile), socket = `tmax-temp-test-${process.pid}`;
const tmux = async args => (await exec('tmux', ['-L', socket, '-f', '/dev/null', ...args])).stdout;
const shares = new Map(); let starts = 0, failShare = false;
const backend = {
  tmux, metadataCacheKey: () => socket,
  async terminalShare({action, target}) {
    if (action === 'stop') { shares.delete(target); return {}; }
    return shares.get(target) || {};
  },
};
const startShare = async ({ target, ttlSeconds, allowControl }) => {
  starts++;
  if (failShare) throw Error('network failed');
  const share = { viewerUrl: `https://share.xyznot.com/s/${starts}`, expiresAt: Date.now() + ttlSeconds * 1000, ttlSeconds, allowControl };
  shares.set(target, share); return share;
};
const manager = temporaryTerminals(backend, startShare);
try {
  assert.deepEqual(await manager.list(), [], 'no tmux server means an empty list');
  await tmux(['new-session', '-d', '-s', 'unrelated', 'sleep 600']);
  await tmux(['set-option', '-g', 'default-command', 'exit 42']);
  const id = randomUUID();
  const results = await Promise.all(Array.from({length: 10}, () => manager.run('create', id)));
  assert.equal(starts, 1, 'concurrent retries reuse one shell/share');
  assert.equal((await manager.list()).length, 1);
  const { terminal, share } = results[0];
  assert.equal(share.ttlSeconds, 600);
  assert.equal(share.allowControl, true);
  const inspect = async () => (await tmux(['display-message', '-p', '-t', terminal.paneId, '#{pane_pid}\t#{pane_current_path}\t#{pane_dead}'])).trim().split('\t');
  const before = await inspect();
  assert.equal(before[1], os.homedir(), 'shell starts in home directory');
  assert.equal(before[2], '0', 'explicit shell bypasses agent default-command');
  await tmux(['send-keys', '-t', terminal.paneId, 'printf "SHELL_READY:%s:%s\\n" "$-" "$PWD"', 'Enter']);
  let output = '';
  for(let i=0; i<40; i++) {
    output = await tmux(['capture-pane', '-p', '-t', terminal.paneId]);
    if (/SHELL_READY:[^\n]*i[^\n]*:\//.test(output)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(output, /SHELL_READY:[^\n]*i[^\n]*:\//, 'shell is interactive and accepts commands');
  const renewed = await manager.run('extend', id);
  assert(renewed.share.expiresAt >= share.expiresAt + 599000);
  assert.deepEqual(await inspect(), before, 'renewal preserves process');
  await manager.run('stop', id);
  assert.deepEqual(await inspect(), before, 'stop only revokes share');
  const restartedManager = temporaryTerminals(backend, startShare);
  assert.equal((await restartedManager.list())[0].id, id, 'marker survives controller restart');
  const reopened = await restartedManager.run('open', id);
  assert.equal(reopened.terminal.paneId, terminal.paneId);
  shares.set(terminal.paneId, { ...reopened.share, expiresAt: Date.now() - 1 });
  assert.equal((await manager.run('open', id)).share.ttlSeconds, 600, 'expired share reopens same shell');
  assert.deepEqual(await inspect(), before);
  await assert.rejects(manager.run('close', '@0'), /Invalid/);
  await assert.rejects(manager.run('close', randomUUID()), /no longer exists/);
  failShare = true;
  const retryId = randomUUID();
  await assert.rejects(manager.run('create', retryId), /network failed/);
  const retained = (await manager.list()).find(row => row.id === retryId);
  assert(retained, 'failed sharing retains recoverable shell');
  failShare = false;
  assert.equal((await manager.run('create', retryId)).terminal.paneId, retained.paneId);
  await manager.run('close', retryId);
  await manager.run('close', id);
  assert.deepEqual(await manager.list(), []);
  assert.match(await tmux(['list-sessions', '-F', '#{session_name}']), /unrelated/);
  console.log('temporary terminals: real tmux creation, retries, renewal, recovery, expiry and isolated cleanup passed');
} finally { await tmux(['kill-server']).catch(() => {}); }
