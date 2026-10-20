// Mobile keyboards commit text through input/composition events, sometimes
// with keyCode 229 and no keyup. xterm 6's desktop key bookkeeping can drop
// those commits. Own the text path on touch devices; xterm still handles
// hardware shortcuts, arrows, paste and terminal escape sequences.
export function installMobileInput(
  textarea: HTMLTextAreaElement,
  root: HTMLElement,
  send: (text: string) => void,
  writable: () => boolean,
) {
  let committed = '';
  let composing = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const listeners: Array<[string, EventListener]> = [];

  function reset() {
    clearTimeout(pending);
    pending = undefined;
    composing = false;
    committed = '';
    textarea.value = '';
  }
  function flush() {
    clearTimeout(pending);
    pending = undefined;
    if (composing) return;
    if (!writable()) { reset(); return; }
    // Keep the textarea intact while the IME is editing it. Compare Unicode
    // code points so an emoji is not erased as two UTF-16 surrogate halves.
    const previous = Array.from(committed);
    const next = Array.from(textarea.value);
    let common = 0;
    while (common < previous.length && previous[common] === next[common]) common++;
    const text = '\x7f'.repeat(previous.length - common) + next.slice(common).join('');
    committed = textarea.value;
    if (text) send(text);
  }
  function beforeCommand() {
    if (composing) return false;
    flush();
    reset();
    return true;
  }
  function listen(type: string, handler: (event: any) => void) {
    const listener: EventListener = event => {
      if (event.target === textarea) handler(event);
    };
    listeners.push([type, listener]);
    // An ancestor capture listener runs before xterm's textarea listeners.
    root.addEventListener(type, listener, true);
  }
  listen('compositionstart', (event: CompositionEvent) => {
    event.stopImmediatePropagation();
    flush();
    composing = true;
  });
  listen('compositionupdate', (event: CompositionEvent) => event.stopImmediatePropagation());
  listen('compositionend', (event: CompositionEvent) => {
    event.stopImmediatePropagation();
    composing = false;
    // WebKit and Chromium differ in whether the final input happens before
    // or after compositionend. Read the final value once, after either order.
    pending = setTimeout(flush, 0);
  });
  listen('keydown', (event: KeyboardEvent) => {
    const textKey = !event.ctrlKey && !event.metaKey && !event.altKey &&
      (Array.from(event.key).length === 1 || event.key === 'Backspace');
    if (composing || event.isComposing || event.keyCode === 229 || event.key === 'Process' || textKey) {
      // Do not preventDefault: the keyboard must still edit the textarea.
      event.stopImmediatePropagation();
    } else if (!['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) {
      beforeCommand();
    }
  });
  listen('keypress', (event: KeyboardEvent) => {
    if (composing || event.isComposing || event.keyCode === 229 ||
        (!event.ctrlKey && !event.metaKey && !event.altKey && Array.from(event.key).length === 1)) {
      event.stopImmediatePropagation();
    }
  });
  listen('beforeinput', (event: InputEvent) => {
    if (composing || event.isComposing) return;
    if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (beforeCommand() && writable()) send('\r');
    } else if (event.inputType === 'deleteContentBackward' && textarea.value === '') {
      // A remote prompt may contain text not present in our local IME buffer.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (writable()) send('\x7f');
    }
  });
  listen('input', (event: InputEvent) => {
    event.stopImmediatePropagation();
    if (!writable()) { reset(); return; }
    if (!composing && !event.isComposing) flush();
  });
  listen('paste', () => { beforeCommand(); }); // xterm owns bracketed paste.
  listen('blur', reset); // Never replay a deferred commit after control is lost.
  return {
    reset, beforeCommand,
    dispose() {
      reset();
      for (const [type, listener] of listeners) root.removeEventListener(type, listener, true);
    },
  };
}
