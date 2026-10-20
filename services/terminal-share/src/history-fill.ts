import type { Terminal, IBufferCell, ITheme } from '@xterm/xterm';

// Keep the parser at the host's dimensions: resizing its rows would change the
// meaning of absolute cursor moves and scrolling regions in the live byte stream.
// Only the presentation grows, using history already held in xterm's buffer.
export function historyRange(available: number, screenHeight: number, rows: number, baseY: number, viewportY: number) {
  const cellHeight = screenHeight / rows;
  const capacity = cellHeight > 0 ? Math.max(0, Math.floor((available - screenHeight) / cellHeight)) : 0;
  const count = Math.min(capacity, baseY);
  const end = Math.max(count, viewportY);
  return { start: end - count, end, count, cellHeight };
}
const ansi = ['#2e3436','#cc0000','#4e9a06','#c4a000','#3465a4','#75507b','#06989a','#d3d7cf','#555753','#ef2929','#8ae234','#fce94f','#729fcf','#ad7fa8','#34e2e2','#eeeeec'];
const names = ['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'] as const;
function palette(n: number, theme: ITheme) {
  if (n < 16) return theme[names[n]] || ansi[n];
  if (theme.extendedAnsi?.[n - 16]) return theme.extendedAnsi[n - 16];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const v = [0,95,135,175,215,255]; n -= 16;
  return `rgb(${v[Math.floor(n / 36)]},${v[Math.floor(n / 6) % 6]},${v[n % 6]})`;
}
function cellStyle(cell: IBufferCell, theme: ITheme, brightBold: boolean) {
  const color = (fg: boolean) => {
    let n = fg ? cell.getFgColor() : cell.getBgColor();
    if (fg ? cell.isFgRGB() : cell.isBgRGB()) return '#' + n.toString(16).padStart(6, '0');
    if (fg ? cell.isFgPalette() : cell.isBgPalette()) {
      if (fg && brightBold && cell.isBold() && n < 8) n += 8;
      return palette(n, theme);
    }
    return (fg ? theme.foreground : theme.background) || (fg ? '#fff' : '#000');
  };
  let fg = color(true), bg = color(false);
  if (cell.isInverse()) [fg, bg] = [bg, fg];
  if (cell.isInvisible()) fg = bg;
  const decorations = [cell.isUnderline() && 'underline', cell.isStrikethrough() && 'line-through', cell.isOverline() && 'overline'].filter(Boolean).join(' ');
  return `color:${fg};background:${bg};font-weight:${cell.isBold() ? 'bold' : 'normal'};font-style:${cell.isItalic() ? 'italic' : 'normal'};opacity:${cell.isDim() ? '.5' : '1'};text-decoration:${decorations || 'none'}`;
}

export function installHistoryFill(viewport: HTMLElement, terminal: Terminal, changed: () => void) {
  const history = document.createElement('div');
  history.id = 'terminal-history';
  history.setAttribute('aria-label', 'Terminal history');
  viewport.insertBefore(history, viewport.firstChild);
  let pending = false;
  let lineHeight = 16;
  let lastSignature = '';
  function render() {
    pending = false;
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) return;
    const box = screen.getBoundingClientRect();
    const css = getComputedStyle(viewport);
    const available = viewport.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
    const buffer = terminal.buffer.active;
    const range = historyRange(available, box.height, terminal.rows, buffer.baseY, buffer.viewportY);
    lineHeight = range.cellHeight || 16;
    // At the oldest history, keep the entire display full rather than shrinking
    // its prefix as xterm's own (shorter) viewport reaches line zero.
    if (range.end !== buffer.viewportY) terminal.scrollToLine(range.end);
    const options = terminal.options;
    history.style.fontFamily = options.fontFamily || 'monospace';
    history.style.fontSize = `${options.fontSize}px`;
    history.style.lineHeight = `${lineHeight}px`;
    history.style.width = `${box.width}px`;
    const fragment = document.createDocumentFragment();
    const cellWidth = box.width / terminal.cols;
    let signature = `${range.start}:${range.end}:${lineHeight}:${box.width}:`;
    for (let y = range.start; y < range.end; y++) {
      const row = document.createElement('div');
      row.style.height = `${lineHeight}px`;
      const line = buffer.getLine(y);
      let span: HTMLSpanElement | undefined, previous = '', width = 0;
      for (let x = 0; line && x < terminal.cols; x++) {
        const cell = line.getCell(x);
        if (!cell || !cell.getWidth()) continue;
        const style = cellStyle(cell, options.theme || {}, options.drawBoldTextInBrightColors !== false);
        if (!span || style !== previous) {
          span = document.createElement('span');
          span.style.cssText = style;
          row.appendChild(span); previous = style; width = 0;
          signature += style;
        }
        const text = cell.getChars() || ' ';
        span.textContent += text;
        width += cell.getWidth();
        span.style.width = `${width * cellWidth}px`;
        signature += text;
      }
      signature += '\n';
      fragment.appendChild(row);
    }
    // Avoid disturbing selection when output doesn't change the displayed rows.
    if (signature !== lastSignature) {
      history.replaceChildren(fragment);
      lastSignature = signature;
    }
    history.hidden = range.count === 0;
    changed();
  }
  function refresh() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(render);
  }
  const resize = new ResizeObserver(refresh);
  resize.observe(viewport);
  resize.observe(terminal.element!);
  terminal.onRender(refresh);
  terminal.onScroll(refresh);
  terminal.onResize(refresh);
  history.addEventListener('wheel', event => {
    if (event.ctrlKey || !event.deltaY) return;
    event.preventDefault();
    const pixels = event.deltaMode === 1 ? event.deltaY * lineHeight : event.deltaMode === 2 ? event.deltaY * viewport.clientHeight : event.deltaY;
    terminal.scrollLines(Math.sign(pixels) * Math.max(1, Math.round(Math.abs(pixels) / lineHeight)));
  }, { passive: false });
  let touchY: number | undefined;
  history.addEventListener('touchstart', event => { touchY = event.touches[0]?.clientY; }, { passive: true });
  history.addEventListener('touchmove', event => {
    const y = event.touches[0]?.clientY;
    if (touchY === undefined || y === undefined) return;
    const lines = Math.trunc((touchY - y) / lineHeight);
    if (lines) { event.preventDefault(); terminal.scrollLines(lines); touchY = y; }
  }, { passive: false });
  refresh();
  return { refresh };
}
