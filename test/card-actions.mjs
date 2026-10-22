import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { CARD_ACTIONS, CARD_ACTION_COLUMNS } from '../public/card-actions.js';
import { renderCardActionBar } from '../public/card-action-bar.mjs';

// Product contract: five fixed positions per row on Web, iOS and Android.
const order = ['interact', 'conversation', 'drafts', 'transcript', 'read', 'terminal', 'share', 'copyLink', 'rename', 'delete'];
const slots = html => [...html.matchAll(/data-card-action="([^"]+)"/g)].map(match => match[1]);
assert.equal(CARD_ACTION_COLUMNS, 5);
assert.deepEqual(CARD_ACTIONS.map(action => action.id), order);

const empty = renderCardActionBar({});
assert.deepEqual(slots(empty), order, 'unavailable actions retain their slots');
assert.equal((empty.match(/ disabled/g) || []).length, 10);
assert.equal((empty.match(/<a /g) || []).length, 0, 'unavailable links are disabled buttons');

const reading = renderCardActionBar({
  conversation: { href: '/conversation?sessionId=test&kind=codex' },
  terminal: { href: '/app/?windowId=%401' },
  read: { label: 'Stop reading', icon: 'stop', active: true, attributes: { 'data-read-key': 'machine::@1' } },
  rename: { disabled: true, busy: true },
  copyLink: { attributes: { 'data-copy-conversation-key': 'machine::"test' } },
});
assert.deepEqual(slots(reading), order, 'reading/busy states must not reorder actions');
assert.match(reading, /aria-label="Stop reading"/);
assert.match(reading, /data-read-key="machine::@1"/);
assert.match(reading, /data-copy-conversation-key="machine::&quot;test"/);
assert.match(reading, /href="\/conversation\?sessionId=test&amp;kind=codex"/);
assert.match(reading, /aria-busy="true"[^>]+disabled/);
assert.match(reading, /class="[^"]*cc-open-button[^"]*" data-card-action="terminal"/);
assert.equal((reading.match(/cc-open-button/g) || []).length, 1, 'keyboard navigation must target Terminal, never another card link');

const mobile = new URL('../../tmux-mobile-mobile/sources/tmux-mobile/card-actions.js', import.meta.url);
if (existsSync(mobile)) assert.equal(readFileSync(mobile, 'utf8'), readFileSync(new URL('../public/card-actions.js', import.meta.url), 'utf8'), 'native must bundle the same canonical contract');
console.log('Card action layout, disabled slots, state changes, escaping and native parity passed.');
