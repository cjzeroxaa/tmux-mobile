(() => {
  const visibleNodes = () => {
    const nodes = [],
      walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.parentElement.closest("script,style,noscript,template,[hidden]"))
        continue;
      if (
        !n.parentElement.getClientRects().length ||
        getComputedStyle(n.parentElement).visibility === "hidden"
      )
        continue;
      nodes.push(n);
    }
    return nodes;
  };
  let comments = [];
  function locate(anchor) {
    const nodes = visibleNodes(),
      text = nodes.map((n) => n.nodeValue).join("");
    const match = locateDraftQuote(text, anchor);
    if (match.status !== "found") return match;
    const range = document.createRange();
    let offset = 0;
    for (const n of nodes) {
      const end = offset + n.length;
      if (match.start >= offset && match.start < end)
        range.setStart(n, match.start - offset);
      if (match.end > offset && match.end <= end) {
        range.setEnd(n, match.end - offset);
        break;
      }
      offset = end;
    }
    return { ...match, range };
  }
  const post = (data) =>
    parent.postMessage({ source: "tmax-draft", ...data }, "*");
  function annotate() {
    const ranges = [],
      states = [];
    for (const c of comments) {
      if (!c.anchor?.quote) continue;
      const found = locate(c.anchor);
      states.push({ id: c.id, status: found.status });
      if (found.range) ranges.push(found.range);
    }
    if (globalThis.Highlight && CSS.highlights)
      CSS.highlights.set("draft-comments", new Highlight(...ranges));
    post({ type: "anchors", states });
  }
  document.addEventListener("selectionchange", () => {
    const selection = getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0),
      nodes = visibleNodes();
    let text = "",
      start = -1,
      end = -1;
    for (const n of nodes) {
      if (range.intersectsNode(n)) {
        const a = range.startContainer === n ? range.startOffset : 0;
        const b = range.endContainer === n ? range.endOffset : n.length;
        if (b > a) {
          if (start < 0) start = text.length + a;
          end = text.length + b;
        }
      }
      text += n.nodeValue;
    }
    if (start < 0 || end <= start || end - start > 12000) return;
    post({
      type: "selection",
      anchor: {
        quote: text.slice(start, end),
        prefix: text.slice(Math.max(0, start - 80), start),
        suffix: text.slice(end, end + 80),
      },
    });
  });
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.source !== "tmax-host") return;
    if (event.data.type === "clear-selection") getSelection()?.removeAllRanges();
    if (event.data.type === "comments") {
      comments = event.data.comments || [];
      annotate();
    }
    if (event.data.type === "focus") {
      const c = comments.find((c) => c.id === event.data.id),
        found = c?.anchor?.quote && locate(c.anchor);
      if (found?.range) {
        found.range.startContainer.parentElement.scrollIntoView({
          block: "center",
          behavior: "smooth",
        });
        if (globalThis.Highlight && CSS.highlights)
          CSS.highlights.set("draft-focus", new Highlight(found.range));
      }
    }
  });
  const style = document.createElement("style");
  style.textContent =
    "::highlight(draft-comments){background:#e8c67c80;color:inherit}::highlight(draft-focus){background:#e0914daa;color:inherit}";
  document.head.append(style);
  document.addEventListener("click", (event) => {
    if (event.target.closest("a")) event.preventDefault();
  });
  post({ type: "ready" });
})();
