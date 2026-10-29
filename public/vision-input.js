// The native app supplies an explicit marker, including when visionOS runs the
// iPad-compatible binary. Do not guess from the iPad/Mac Safari user agent.
export function isVisionDevice(userAgent = navigator.userAgent) {
  return /\b(?:TMaxVision\/1|visionOS)\b/i.test(userAgent);
}

// Keep the form value for existing submit/upload handlers, but remove the field
// from layout and focus. Programmatic value changes update a plain text preview.
export function visionTextPreview(input) {
  if (!isVisionDevice()) return null;
  const preview = document.createElement('div');
  preview.className = input.className;
  preview.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;min-height:2em;padding:8px;';
  preview.setAttribute('aria-label', input.getAttribute('aria-label') || input.placeholder || 'Text');
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
  const update = () => { preview.textContent = input.value || input.placeholder || ''; };
  if (descriptor?.get && descriptor?.set) {
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) { descriptor.set.call(this, value); update(); },
    });
  }
  input.blur();
  input.hidden = true;
  input.style.setProperty('display', 'none', 'important');
  input.tabIndex = -1;
  input.after(preview);
  input.addEventListener('input', update);
  update();
  return preview;
}
