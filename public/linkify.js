// Pure helpers for detecting URLs in tmux pane output and turning them into
// clickable links. Kept dependency-free (no DOM) so they can be unit-tested in
// node and imported by app.js. These operate on ALREADY-HTML-ESCAPED text — the
// output of escapeHtml() — so wrapping URL spans in <a> tags is safe.

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function unescapeHtmlEntities(value) {
  return String(value)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&amp;", "&"); // last: avoid double-decoding "&amp;lt;" etc.
}

// Matches http(s):// and www. URLs in escaped text. `&` in query strings is
// `&amp;` after escaping, so the body class allows `;` and `&`; trailing
// punctuation/entities are trimmed in linkifyEscaped.
export const URL_IN_ESCAPED = /(\bhttps?:\/\/|\bwww\.)[^\s<>"']+/gi;

// Wrap URLs found in an already-escaped chunk with anchor tags. The href is
// un-escaped back to raw characters (e.g. &amp; -> &) so the link points where
// the terminal shows; the displayed text keeps its escaping.
export function linkifyEscaped(escaped) {
  return String(escaped).replace(URL_IN_ESCAPED, (match) => {
    let url = match;
    let trailing = "";
    // Trailing chars almost never part of a URL: sentence punctuation, a closing
    // bracket/paren/brace, quote, or a half-escaped entity tail (regex stopping
    // mid-"&amp;").
    const trim = /(&(?:amp|gt|lt|quot|#039);|[.,;:!?)\]}'"])+$/;
    const tail = url.match(trim);
    if (tail) {
      trailing = tail[0];
      url = url.slice(0, url.length - trailing.length);
    }
    if (!url) return match;
    const rawHref = unescapeHtmlEntities(url);
    const href = /^www\./i.test(rawHref) ? `https://${rawHref}` : rawHref;
    const safeHref = href.replaceAll('"', "%22");
    return `<a href="${safeHref}" class="pane-link" target="_blank" rel="noopener noreferrer">${url}</a>${trailing}`;
  });
}
