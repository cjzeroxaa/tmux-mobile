import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TerminalShareUpload } from '../lib/terminal-share-upload.mjs';
import { localBackend } from '../lib/backend.mjs';

const dir = await mkdtemp(path.join(os.tmpdir(), 'tmax-upload-test-'));
process.env.TMUX_MOBILE_UPLOAD_DIR = dir;
const upload = new TerminalShareUpload(localBackend);
try {
  const chunk = Buffer.alloc(65536, 0x5a);
  const size = 26 * 1024 * 1024;
  await upload.handle('upload.start', { id: 'large', name: '../../sample.bin', size });
  for (let offset = 0; offset < size; offset += chunk.length) {
    await upload.handle('upload.chunk', { id: 'large', offset, data: chunk.toString('base64') });
  }
  const saved = await upload.handle('upload.end', { id: 'large' });
  assert.equal(saved.path, path.join(dir, 'sample.bin'));
  assert.deepEqual(await readFile(saved.path), Buffer.alloc(size, 0x5a));
  await upload.handle('upload.start', { id: 'cancel', name: 'partial.bin', size: 100 });
  await upload.handle('upload.chunk', { id: 'cancel', offset: 0, data: Buffer.from('part').toString('base64') });
  await upload.cancel();
  assert.deepEqual(await readdir(dir), ['sample.bin'], 'cancel removes partial file');
  await upload.handle('upload.start', { id: 'empty', name: 'sample.bin', size: 0 });
  const empty = await upload.handle('upload.end', { id: 'empty' });
  assert.equal(empty.name, 'sample-1.bin', 'existing file preserved');
  await upload.handle('upload.start', { id: 'order', name: 'order', size: 10 });
  await assert.rejects(upload.handle('upload.chunk', { id: 'order', offset: 1, data: 'YQ==' }), /offset/);
  await assert.rejects(upload.handle('upload.end', { id: 'order' }), /Incomplete/);
  await upload.cancel();
  console.log('Shared upload: >25 MB, exact bytes, safe paths, collisions, cancellation and offsets passed');
} finally {
  await upload.cancel();
  await rm(dir, { recursive: true, force: true });
}
