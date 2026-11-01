import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { CARD_ACTIONS, CARD_ACTION_LAYOUT } from '../public/card-actions.js';
import { renderCardActionBar } from '../public/card-action-bar.mjs';

// Product contract: every client uses the same action order.
const order = ['interact', 'conversation', 'drafts', 'transcript', 'terminal', 'share', 'copyLink', 'rename', 'delete'];
const slots = html => [...html.matchAll(/data-card-action="([^"]+)"/g)].map(match => match[1]);
assert.equal(CARD_ACTION_LAYOUT.height, 32);
assert.deepEqual(CARD_ACTIONS.map(action => action.id), order);

const empty = renderCardActionBar({});
assert.deepEqual(slots(empty), order, 'unavailable actions retain their slots');
assert.equal((empty.match(/ disabled/g) || []).length, 9);
assert.equal((empty.match(/<a /g) || []).length, 0, 'unavailable links are disabled buttons');

const busyActions = renderCardActionBar({
  conversation: { href: '/conversation?sessionId=test&kind=codex' },
  terminal: { href: '/app/?windowId=%401' },
  rename: { disabled: true, busy: true },
  copyLink: { attributes: { 'data-copy-conversation-key': 'machine::"test' } },
});
assert.deepEqual(slots(busyActions), order, 'busy states must not reorder actions');
assert.match(busyActions, /data-copy-conversation-key="machine::&quot;test"/);
assert.match(busyActions, /href="\/conversation\?sessionId=test&amp;kind=codex"/);
assert.match(busyActions, /aria-busy="true"[^>]+disabled/);
assert.match(busyActions, /class="[^"]*cc-open-button[^"]*" data-card-action="terminal"/);
assert.equal((busyActions.match(/cc-open-button/g) || []).length, 1, 'keyboard navigation must target Terminal, never another card link');

const mobile = new URL('../../tmux-mobile-mobile/sources/tmux-mobile/card-actions.js', import.meta.url);
if (existsSync(mobile)) assert.equal(readFileSync(mobile, 'utf8'), readFileSync(new URL('../public/card-actions.js', import.meta.url), 'utf8'), 'native must bundle the same canonical contract');
console.log('Card action layout, disabled slots, state changes, escaping and native parity passed.');
