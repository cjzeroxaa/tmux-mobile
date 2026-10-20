import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source = stripTypeScriptTypes(await readFile(new URL('../src/mobile-input.ts', import.meta.url), 'utf8'));
const { installMobileInput } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const turn = () => new Promise(resolve => setTimeout(resolve, 5));
function fixture() {
  const textarea = { value: '' };
  const listeners = new Map();
  const root = { addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); } };
  const sent = [];
  let writable = true;
  const bridge = installMobileInput(textarea, root, text => sent.push(text), () => writable);
  function event(type, data = {}) {
    const ev = { target: textarea, key: '', ...data, stopped: false, prevented: false,
      stopImmediatePropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } };
    listeners.get(type)?.(ev);
    return ev;
  }
  function input(value, data = {}) { textarea.value = value; return event('input', { inputType: 'insertText', ...data }); }
  return { textarea, event, input, sent, bridge, lose() { writable = false; bridge.reset(); } };
}
test('229 without keyup cannot swallow a candidate selected without composition events', () => {
  const f = fixture();
  assert.equal(f.event('keydown', { key: 'Unidentified', keyCode: 229 }).stopped, true);
  f.input('codex', { inputType: 'insertReplacementText', data: 'codex' });
  assert.deepEqual(f.sent, ['codex']);
});
test('composition sends only the selected candidate, once, with final input after end', async () => {
  const f = fixture();
  f.event('compositionstart');
  f.input('zhong', { isComposing: true });
  assert.deepEqual(f.sent, []);
  f.event('compositionend');
  f.input('中文', { inputType: 'insertFromComposition' });
  await turn();
  assert.deepEqual(f.sent, ['中文']);
});
test('final input before compositionend and no final input both commit once', async () => {
  for (const emitInput of [true, false]) {
    const f = fixture();
    f.event('compositionstart');
    f.textarea.value = 'codex';
    if (emitInput) f.event('input', { isComposing: true });
    f.event('compositionend');
    await turn();
    assert.deepEqual(f.sent, ['codex']);
  }
});
test('candidate confirmation Enter never executes a command', async () => {
  const f = fixture();
  f.event('compositionstart'); f.input('codex', { isComposing: true });
  assert.equal(f.event('keydown', { key: 'Enter', keyCode: 229 }).stopped, true);
  f.event('compositionend'); await turn();
  assert.deepEqual(f.sent, ['codex']);
  const enter = f.event('beforeinput', { inputType: 'insertLineBreak' });
  assert.equal(enter.prevented, true);
  assert.deepEqual(f.sent, ['codex', '\r']);
});
test('typing, autocorrection, punctuation and backward delete send minimal changes', () => {
  const f = fixture();
  f.input('codez'); f.input('codex', { inputType: 'insertReplacementText' });
  f.input('codex '); f.input('codex', { inputType: 'deleteContentBackward' }); f.input('codex。');
  assert.deepEqual(f.sent, ['codez', '\x7fx', ' ', '\x7f', '。']);
});
test('deletion on an empty input still reaches the remote prompt; emoji uses one code point', () => {
  const f = fixture();
  f.event('beforeinput', { inputType: 'deleteContentBackward' });
  f.input('😀'); f.input('');
  assert.deepEqual(f.sent, ['\x7f', '😀', '\x7f']);
});
test('composition cancellation and repeated final input send no duplicate', async () => {
  const f = fixture();
  f.event('compositionstart'); f.input('no', { isComposing: true }); f.textarea.value = '';
  f.event('compositionend'); await turn(); assert.deepEqual(f.sent, []);
  f.input('hi'); f.input('hi'); assert.deepEqual(f.sent, ['hi']);
});
test('pending commit is flushed before terminal keys; unfinished composition blocks them', () => {
  const f = fixture();
  f.event('compositionstart'); f.input('hi', { isComposing: true });
  assert.equal(f.bridge.beforeCommand(), false);
  f.event('compositionend');
  assert.equal(f.bridge.beforeCommand(), true);
  assert.deepEqual(f.sent, ['hi']); assert.equal(f.textarea.value, '');
});
test('blur or control loss cancels pending text, without replay on a later input', async () => {
  for (const stop of ['blur', 'lose']) {
    const f = fixture(); f.event('compositionstart'); f.input('secret', { isComposing: true }); f.event('compositionend');
    if (stop === 'blur') f.event('blur'); else f.lose();
    await turn(); assert.deepEqual(f.sent, []); assert.equal(f.textarea.value, '');
  }
});
test('ordinary text bypasses xterm keypress but arrows and hardware shortcuts remain native', () => {
  const f = fixture();
  assert.equal(f.event('keydown', { key: 'a' }).stopped, true);
  assert.equal(f.event('keypress', { key: 'a' }).stopped, true);
  assert.equal(f.event('keydown', { key: 'ArrowLeft' }).stopped, false);
  assert.equal(f.event('keydown', { key: 'c', ctrlKey: true }).stopped, false);
});
