import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source = stripTypeScriptTypes(await readFile(new URL('../src/viewport.ts', import.meta.url), 'utf8'));
const { createViewportFollow } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
function fixture() {
  const viewport = { scrollTop: 0, scrollHeight: 900, clientHeight: 500 };
  const terminal = { buffer: { active: { baseY: 600, viewportY: 600 } }, scrollToLine(y) { this.buffer.active.viewportY = y; } };
  const tasks = [];
  const follow = createViewportFollow(viewport, terminal, task => tasks.push(task));
  const flush = () => { while (tasks.length) tasks.shift()(); };
  return { viewport, terminal, follow, flush };
}
test('initial snapshot reveals the bottom of a remote screen taller than the browser', () => {
  const { viewport, follow, flush } = fixture();
  follow.snapshot()(); flush();
  assert.equal(viewport.scrollTop, 400);
});
test('new output and keyboard resize follow the outer and inner terminal together', () => {
  const { viewport, follow, flush } = fixture();
  follow.changed(); flush();
  viewport.clientHeight = 300;
  follow.innerScrolled(); // Output at xterm's bottom must not cancel following.
  follow.changed(); flush();
  assert.equal(viewport.scrollTop, 600);
});
test('upward gesture cancels an output scroll already queued before its scroll event', () => {
  const { viewport, follow, flush } = fixture();
  follow.changed();
  follow.pause();
  viewport.scrollTop = 100;
  flush();
  assert.equal(viewport.scrollTop, 100);
  follow.scrolled(); follow.changed(); flush();
  assert.equal(viewport.scrollTop, 100);
});
test('reading xterm history pauses following; reaching both bottoms resumes it', () => {
  const { viewport, terminal, follow, flush } = fixture();
  follow.changed(); flush();
  terminal.buffer.active.viewportY = 200;
  follow.innerScrolled();
  viewport.clientHeight = 300;
  follow.changed(); flush();
  assert.equal(viewport.scrollTop, 400);
  terminal.buffer.active.viewportY = 600;
  viewport.scrollTop = 600;
  follow.scrolled();
  viewport.clientHeight = 200;
  follow.changed(); flush();
  assert.equal(viewport.scrollTop, 700);
});
test('a resized snapshot preserves the paused history offset and page position', () => {
  const { viewport, terminal, follow, flush } = fixture();
  viewport.scrollTop = 90;
  terminal.buffer.active.viewportY = 400;
  follow.scrolled();
  const complete = follow.snapshot();
  terminal.buffer.active = { baseY: 650, viewportY: 650 };
  follow.innerScrolled();
  complete(); flush();
  assert.equal(terminal.buffer.active.viewportY, 450);
  assert.equal(viewport.scrollTop, 90);
});
