import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_NOTIFICATION_SETTINGS, validateNotificationSettings, isNotificationQuietTime, canEditNotificationSettings, createNotificationSettingsStore } from '../lib/notification-settings.mjs';

const quiet = { enabled: true, start: '21:00', end: '08:00', timeZone: 'Asia/Shanghai' };
for (const [date, expected] of [['2026-10-10T12:59:59Z', false], ['2026-10-10T13:00:00Z', true], ['2026-10-10T23:59:59Z', true], ['2026-10-11T00:00:00Z', false]]) {
  assert.equal(isNotificationQuietTime(quiet, date), expected, date);
  assert.equal(isNotificationQuietTime(DEFAULT_NOTIFICATION_SETTINGS, date), false, 'off never mutes');
}
const daytime = { ...quiet, start: '09:00', end: '17:00', timeZone: 'America/Los_Angeles' };
assert.equal(isNotificationQuietTime(daytime, '2026-10-10T16:00:00Z'), true);
assert.equal(isNotificationQuietTime(daytime, '2026-10-11T00:00:00Z'), false);
assert.equal(isNotificationQuietTime(daytime, '2026-12-10T16:00:00Z'), false, 'timezone follows winter offset');
assert.equal(isNotificationQuietTime(daytime, '2026-12-10T17:00:00Z'), true);
for (const value of [null, { ...quiet, enabled: 'true' }, { ...quiet, start: '24:00' }, { ...quiet, end: '08:60' }, { ...quiet, end: '21:00' }, { ...quiet, timeZone: 'Mars/Orbit' }]) {
  assert.throws(() => validateNotificationSettings(value), error => error.status === 400);
}
assert.equal(canEditNotificationSettings({ email: 'ADMIN@example.com' }, ['admin@example.com']), true);
assert.equal(canEditNotificationSettings({ email: 'other@example.com' }, ['admin@example.com']), false);
assert.equal(canEditNotificationSettings(null, ['admin@example.com']), false);
assert.equal(canEditNotificationSettings(null, [], false), true);

const dir = await mkdtemp(path.join(tmpdir(), 'notification-settings-'));
try {
  const env = { TMUX_MOBILE_NOTIFICATION_SETTINGS_STORE: 'file', TMUX_MOBILE_NOTIFICATION_SETTINGS_CONFIG: path.join(dir, 'settings.json') };
  const store = await createNotificationSettingsStore(env);
  assert.equal(store.current().enabled, false);
  await store.save(quiet);
  const restarted = await createNotificationSettingsStore(env);
  assert.equal(restarted.current().enabled, true, 'persists across server restarts');
  assert.equal(restarted.current().timeZone, quiet.timeZone);
  await assert.rejects(store.save({ ...quiet, start: 'bad' }));
  assert.equal(store.current().start, quiet.start, 'invalid write leaves current policy intact');
  await Promise.all([store.refresh(), store.save({ ...quiet, enabled: false }), store.refresh()]);
  assert.equal(store.current().enabled, false, 'refresh cannot undo a concurrent write');
  assert.equal((await createNotificationSettingsStore(env)).current().enabled, false);
} finally { await rm(dir, { recursive: true, force: true }); }
console.log('notification-settings tests passed');
