type TerminalView = {
  buffer: { active: { baseY: number; viewportY: number } };
  scrollToLine(line: number): void;
};

// xterm scrolls its own history, while the surrounding page may also scroll
// when the remote terminal is taller than the browser. Follow both together.
export function createViewportFollow(
  viewport: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>,
  terminal: TerminalView,
  schedule: (callback: () => void) => unknown,
) {
  let following = true;
  let revision = 0;
  let pending = false;
  let writingSnapshot = false;
  const outerBottom = () => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;
  const innerBottom = () => terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
  function pause() { following = false; revision++; }
  function scrolled() {
    if (writingSnapshot) return;
    following = outerBottom() && innerBottom();
    if (!following) revision++;
  }
  function innerScrolled() {
    if (writingSnapshot) return;
    if (!innerBottom()) pause();
    else if (outerBottom()) following = true;
  }
  function changed() {
    if (pending || !following) return;
    pending = true;
    const started = revision;
    schedule(() => {
      pending = false;
      // A wheel/touch gesture can precede its scroll event. Never let a queued
      // output callback undo that gesture.
      if (!following || revision !== started || !innerBottom()) return;
      viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    });
  }
  function snapshot() {
    const wasFollowing = following;
    const started = revision;
    const distance = terminal.buffer.active.baseY - terminal.buffer.active.viewportY;
    const top = viewport.scrollTop;
    writingSnapshot = true;
    return () => {
      writingSnapshot = false;
      if (started !== revision) return;
      if (!wasFollowing) {
        terminal.scrollToLine(Math.max(0, terminal.buffer.active.baseY - distance));
        viewport.scrollTop = top;
        following = false;
      } else {
        following = true;
        changed();
      }
    };
  }
  return { pause, scrolled, innerScrolled, changed, snapshot };
}
