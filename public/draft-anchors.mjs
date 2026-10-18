// Refuse ambiguous matches instead of attaching feedback to unrelated text.
export function locateDraftQuote(text, anchor) {
  const quote = anchor?.quote;
  if (!quote) return { status: "missing" };
  const matches = [];
  let from = 0;
  while (from <= text.length) {
    const start = text.indexOf(quote, from);
    if (start < 0) break;
    matches.push(start);
    from = start + Math.max(1, quote.length);
  }
  if (!matches.length) return { status: "missing" };
  const contextual = matches.filter(
    (start) =>
      (!anchor.prefix ||
        text.slice(Math.max(0, start - anchor.prefix.length), start) ===
          anchor.prefix) &&
      (!anchor.suffix ||
        text.slice(
          start + quote.length,
          start + quote.length + anchor.suffix.length,
        ) === anchor.suffix),
  );
  const candidates = contextual.length ? contextual : matches;
  if (candidates.length !== 1) return { status: "ambiguous" };
  return {
    status: "found",
    start: candidates[0],
    end: candidates[0] + quote.length,
  };
}
