import type { Terminal } from '@xterm/xterm';

export function terminalPlainText(buffer: Terminal['buffer']['active']) {
  let text = '';
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    if (i && !line.isWrapped) text += '\n';
    text += line.translateToString(!buffer.getLine(i + 1)?.isWrapped);
  }
  return text.trimEnd();
}
export function installTextSelection(terminal: Terminal, viewport: HTMLElement) {
  const dialog = document.querySelector<HTMLDialogElement>('#text-selection')!;
  const content = document.querySelector<HTMLElement>('#selection-content')!;
  const copy = document.querySelector<HTMLButtonElement>('#selection-copy')!;
  function open() {
    if (dialog.open) return;
    // Snapshot once: incoming output must not move the user's selection.
    content.textContent = terminalPlainText(terminal.buffer.active) || '(No terminal text yet)';
    copy.textContent = 'Copy all';
    terminal.blur();
    dialog.showModal();
    content.scrollTop = 0;
  }
  document.querySelector<HTMLButtonElement>('#select-text')!.onclick = open;
  document.querySelector<HTMLButtonElement>('#selection-close')!.onclick = () => dialog.close();
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(content.textContent || ''); copy.textContent = 'Copied'; }
    catch { copy.textContent = 'Select text to copy'; }
  };
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { x: number; y: number } | undefined;
  function cancel() { clearTimeout(timer); start = undefined; }
  viewport.addEventListener('pointerdown', event => {
    cancel();
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    start = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => { cancel(); open(); }, 550);
  });
  viewport.addEventListener('pointermove', event => {
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel();
  });
  viewport.addEventListener('pointerup', cancel);
  viewport.addEventListener('pointercancel', cancel);
  viewport.addEventListener('contextmenu', event => {
    if (start) { cancel(); open(); event.preventDefault(); }
    else if (dialog.open) event.preventDefault();
  });
  return dialog;
}
