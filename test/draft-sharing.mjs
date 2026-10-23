import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDrafts } from '../lib/drafts.mjs';
import { createDraftStore, memoryDraftStore } from '../lib/draft-store.mjs';
import { handlePublicDraftHttp } from '../lib/draft-http.mjs';
import { ASSET_ORIGIN, machineAssetPrefix, assetSigningKey } from '../lib/draft-assets.mjs';
import { validToken } from '../services/draft-assets/worker.mjs';

const owner = { userId: 'owner@example.test' }, reader = { userId: 'reader@example.test' }, admin = { userId: 'admin@example.test' };
const secret = 'public-draft-test-secret';
const store = memoryDraftStore(), blobs = new Map();
const storage = { async put(key, bytes) { blobs.set(key, bytes); }, async get(key) { return blobs.has(key) ? { bytes: blobs.get(key) } : null; } };
const makeDrafts = (store) => createDrafts({ store, storage,
  canAccess: viewer => [owner.userId, reader.userId, admin.userId].includes(viewer?.userId),
  canManageSharing: (viewer, draft) => viewer?.userId === draft.ownerId || viewer?.userId === admin.userId,
});
let drafts = makeDrafts(store);
const asset = `${ASSET_ORIGIN}/${machineAssetPrefix('machine-one')}${'a'.repeat(64)}.mp4`;
const html = text => `<html><head><title>Public example</title></head><body><h1>${text}</h1><video src="${asset}" controls></video><script>document.body.dataset.interactive='yes';</script></body></html>`;
const publish = (text, expectedVersion = 0) => drafts.publish({ machineId: 'machine-one', ownerId: owner.userId,
  metadata: { kind: 'codex', sessionId: 'secret-session', filename: 'review.html', sourcePath: '/private/source.html', expectedVersion }, bytes: Buffer.from(html(text)) });
const first = await publish('Version one');
const second = await drafts.publish({ machineId: 'machine-one', ownerId: owner.userId, metadata: { kind: 'codex', sessionId: 'different', filename: 'other.html', expectedVersion: 0 }, bytes: Buffer.from(html('Private neighbor')) });
const initial = await drafts.detail(owner, first.id);
assert.deepEqual(initial.sharing, { enabled: false, canManage: true, path: null });
assert.equal((await drafts.detail(reader, first.id)).sharing.canManage, false);
await drafts.comment(owner, first.id, { version: 1, text: 'Private review feedback' });
await assert.rejects(drafts.setSharing(reader, first.id, true), { status: 403 });
await assert.rejects(drafts.setSharing({ userId: 'stranger' }, first.id, true), { status: 404 });
await assert.rejects(drafts.setSharing(owner, first.id, 'true'), { status: 400 });
await assert.rejects(drafts.readPublic(first.id, 'x'.repeat(43)), { status: 404 });
const share = await drafts.setSharing(owner, first.id, true), token = share.path.split('/').at(-1);
assert.match(token, /^[\w-]{43}$/);
assert.equal((await drafts.setSharing(owner, first.id, true)).path, share.path, 'repeated enable preserves the shared address');
await assert.rejects(drafts.readPublic(second.id, token), { status: 404 });
await assert.rejects(drafts.readPublic(first.id, token.slice(0, -1)), { status: 404 });
await assert.rejects(drafts.readPublic(first.id, 'x'.repeat(43)), { status: 404 });
await publish('Version two', 1);
drafts = makeDrafts(store);
assert.equal((await drafts.detail(owner, first.id)).sharing.path, share.path, 'publishing/restarting preserves sharing');
assert.match((await drafts.readPublic(first.id, token)).html, /Version two/);

async function serve(urlPath, method = 'GET', instance = drafts) {
  const headers = {}; let status, body;
  const res = { setHeader(key, value) { headers[key.toLowerCase()] = value; }, writeHead(code, extra) { status = code; for (const [key, value] of Object.entries(extra)) headers[key.toLowerCase()] = value; }, end(value) { body = value; } };
  const handled = await handlePublicDraftHttp({ method }, res, new URL(urlPath, 'http://example.test'), { drafts: instance, assetSessionSecret: secret });
  return { handled, headers, status, body };
}
const page = await serve(`${share.path}?version=1&download=1`);
assert.equal(page.status, 200);
assert.match(page.body, /Version two/);
for (const privateValue of ['Private review feedback', 'private/source', 'secret-session', 'owner@example', 'locateDraftQuote', 'tmax-host', 'Private neighbor']) assert.ok(!page.body.includes(privateValue), privateValue);
assert.match(page.headers['content-security-policy'], /sandbox allow-scripts/);
assert.ok(!page.headers['content-security-policy'].includes('allow-same-origin'));
assert.equal(page.headers['cache-control'], 'private, no-store');
assert.equal(page.headers['referrer-policy'], 'no-referrer');
assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow');
const media = new URL(page.body.match(/src="([^"]+)"/)[1]);
assert.equal(await validToken(media.pathname, media.searchParams.get('token'), assetSigningKey(secret)), true);
assert.equal(page.headers['content-length'], Buffer.byteLength(page.body));
const head = await serve(share.path, 'HEAD');
assert.equal(head.status, 200); assert.equal(head.body, undefined);
assert.equal((await serve(share.path, 'POST')).status, 405);
assert.equal((await serve('/api/drafts')).handled, false);
assert.equal((await serve('/d/bad')).status, 404);
assert.equal((await serve(share.path, 'GET', null)).status, 503);
await drafts.setSharing(admin, first.id, false);
assert.equal((await serve(share.path)).status, 404);
assert.deepEqual((await drafts.detail(owner, first.id)).sharing, { enabled: false, canManage: true, path: null });
const renewed = await drafts.setSharing(owner, first.id, true);
assert.notEqual(renewed.path, share.path);
assert.equal((await serve(share.path)).status, 404, 'revoked address stays invalid after re-enable');
assert.equal((await serve(renewed.path)).status, 200);
assert.equal((await drafts.detail(owner, second.id)).sharing.enabled, false);

// Optimistic writes cannot silently undo another sharing update.
const cas = memoryDraftStore();
const results = await Promise.allSettled([
  cas.put({ family: 'sharing', id: 'a', version: 1, enabled: true }, { expectedVersion: 0 }),
  cas.put({ family: 'sharing', id: 'a', version: 1, enabled: false }, { expectedVersion: 0 }),
]);
assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
const temp = await mkdtemp(path.join(os.tmpdir(), 'draft-sharing-'));
try {
  const env = { TMUX_MOBILE_DRAFTS_CONFIG: path.join(temp, 'drafts.json'), TMUX_MOBILE_COMMENT_INDEX: 'file' };
  const disk = await createDraftStore(env);
  for (const item of store.items.values()) await disk.put(item);
  const restarted = makeDrafts(await createDraftStore(env));
  assert.equal((await restarted.detail(owner, first.id)).sharing.path, renewed.path);
  await restarted.setSharing(owner, first.id, false);
  const stopped = makeDrafts(await createDraftStore(env));
  assert.equal((await serve(renewed.path, 'GET', stopped)).status, 404);
} finally { await rm(temp, { recursive: true, force: true }); }
console.log('Draft sharing: private defaults, owner/admin permissions, anonymous content/media, latest revision, isolation, revocation/rotation, concurrent writes and persistence passed');
