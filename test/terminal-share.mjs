import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TmuxShareStream, decodeTmuxOutput, validateShareConfig } from '../lib/terminal-share.mjs';
import { localBackend } from '../lib/backend.mjs';

assert.deepEqual(decodeTmuxOutput('hi\\012\\033[31m\\134'), Buffer.from('hi\n\x1b[31m\\'));
assert.throws(() => validateShareConfig({ expiresAt: Date.now() + 10000, hostWebSocketUrl: 'wss://attacker.invalid', stopUrl: 'https://attacker.invalid', viewerUrl: 'https://attacker.invalid' }), /Invalid terminal share service/);
const dir = mkdtempSync(path.join(os.tmpdir(), 'tmax-share-test-'));
const socket = `tmax-share-test-${process.pid}`;
const tmux = (...args) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' }).trim();
let stream;
try {
  const pane = tmux('new-session', '-d', '-s', 'share-test', '-x', '100', '-y', '30', '-P', '-F', '#{pane_id}', 'cat');
  const other = tmux('new-window', '-t', 'share-test', '-P', '-F', '#{pane_id}', 'cat');
  const command = path.join(dir, 'tmux');
  writeFileSync(command, `#!/bin/sh\nexec tmux -L ${socket} "$@"\n`, { mode: 0o700 });
  process.env.TMUX_MOBILE_TMUX_COMMAND = command;
  const sessionTarget = (await localBackend.tmux(['display-message', '-p', '-t', pane, '#{session_id}'], { mux: 'tmux' })).trim();
  assert.match(sessionTarget, /^\$\d+$/);
  const output = [];
  stream = new TmuxShareStream({ command, target: pane, sessionTarget, onOutput: bytes => output.push(bytes) });
  await stream.ready;
  const beforeSize = tmux('display-message', '-p', '-t', pane, '#{pane_width},#{pane_height}');
  tmux('send-keys', '-t', pane, 'hello 中文', 'Enter');
  const first = await stream.snapshot();
  assert.match(first.data, /hello 中文/);
  assert.equal(`${first.size.cols},${first.size.rows}`, beforeSize);
  tmux('send-keys', '-t', other, 'OTHER_PANE_SECRET', 'Enter');
  tmux('send-keys', '-t', pane, 'INCREMENTAL_OUTPUT', 'Enter');
  for (let i = 0; i < 50 && !Buffer.concat(output).toString().includes('INCREMENTAL_OUTPUT'); i++) await new Promise(r => setTimeout(r, 20));
  assert.match(Buffer.concat(output).toString(), /INCREMENTAL_OUTPUT/);
  assert.doesNotMatch(Buffer.concat(output).toString(), /OTHER_PANE_SECRET/);
  const count = output.length;
  await new Promise(r => setTimeout(r, 200));
  assert.equal(output.length, count, 'idle terminal produces no output traffic');
  stream.close();
  assert.equal(tmux('display-message', '-p', '-t', pane, '#{pane_id}'), pane, 'closing share keeps the original pane alive');
  assert.equal(tmux('display-message', '-p', '-t', pane, '#{pane_width},#{pane_height}'), beforeSize);
  console.log('terminal-share real tmux checks passed');
} finally {
  stream?.close();
  try { tmux('kill-server'); } catch {}
  rmSync(dir, { recursive: true, force: true });
}
