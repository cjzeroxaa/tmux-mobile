import assert from 'node:assert/strict';
import { isVisionDevice, visionTextPreview } from '../public/vision-input.js';
for (const ua of ['iPad', 'Macintosh Safari', 'Android Chrome', 'iPhone']) assert.equal(isVisionDevice(ua), false);
assert.equal(isVisionDevice('Mozilla/5.0 Safari TMaxVision/1'), true);
assert.equal(isVisionDevice('Mozilla/5.0 visionOS'), true);
class Field extends EventTarget {
  stored = 'Existing text';
  placeholder = 'Speak here';
  className = 'field';
  style = { setProperty: (key, value) => { this.style[key] = value; } };
  get value() { return this.stored; }
  set value(value) { this.stored = String(value); }
  getAttribute() { return 'Draft'; }
  blur() { this.blurred = true; }
  after(preview) { this.preview = preview; }
}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {userAgent:'iPhone'} });
const normal = new Field();
assert.equal(visionTextPreview(normal), null);
assert.equal(normal.hidden, undefined);
globalThis.document = { createElement: () => ({style:{}, setAttribute(){}}) };
navigator.userAgent = 'TMaxVision/1';
const input = new Field();
const preview = visionTextPreview(input);
assert.equal(input.hidden, true);
assert.equal(input.tabIndex, -1);
assert.equal(input.blurred, true);
assert.equal(input.style.display, 'none');
assert.equal(preview.textContent, 'Existing text');
input.value = 'Final transcription';
assert.equal(preview.textContent, 'Final transcription');
input.value = '';
assert.equal(preview.textContent, 'Speak here');
assert.equal(input.value, '');
console.log('Vision fields: explicit device detection, no phone/tablet changes, hidden inputs and live text previews passed.');
