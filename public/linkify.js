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

// File extensions the smart content viewer can render. Keep in sync with the
// server's fileKind()/IMAGE_EXTS/MARKDOWN_EXTS/EXTERNAL_EXTS. Images + markdown
// open in the in-app viewer; webm/mp4/mov/html open in an external tab.
const VIEWABLE_FILE_EXTS =
  "png|jpe?g|gif|svg|webp|bmp|ico|md|markdown|mdown|mkd|webm|mp4|m4v|mov|html?";

// Matches file paths ending in a viewable extension, in already-escaped text.
// Requires either a path separator or a leading ./ ../ ~/ so a bare word like
// "image" isn't matched, but "screenshot.png", "./out.png", "docs/guide.md",
// "/abs/path.md", and "~/notes.md" are. Stops at whitespace/quotes/brackets.
const FILE_IN_ESCAPED = new RegExp(
  String.raw`(?:\.{0,2}\/|~\/)?(?:[^\s<>"'(){}\[\]:]+\/)*[^\s<>"'(){}\[\]:/]+\.(?:${VIEWABLE_FILE_EXTS})\b`,
  "gi",
);

// Turn an already-escaped chunk into HTML with links. `opts.repo` (the active
// window's { host, owner, name }) enables PR-reference linking when present.
export function linkifyEscaped(escaped, opts = {}) {
  let out = linkifyUrls(String(escaped));
  out = linkifyFiles(out);
  if (opts.repo && opts.repo.owner && opts.repo.name) {
    out = linkifyPrRefs(out, opts.repo);
  }
  return out;
}

// Matches "PR #1234" / "PR#1234" (case-insensitive), in already-escaped text.
// Deliberately NOT bare "#1234" — that over-triggers on shell/markdown/diff text.
const PR_REF_IN_ESCAPED = /\bPR\s*#(\d+)\b/gi;

// Link PR references to the active window's GitHub repo. github.com/owner/repo/
// issues/N auto-redirects to the PR, so we don't need to distinguish issue vs PR.
// Runs after URL/file linkify and skips text already inside an <a> so it can't
// double-wrap. Only used when a repo is known.
function linkifyPrRefs(html, repo) {
  const host = repo.host && repo.host !== "github.com" ? repo.host : "github.com";
  const parts = html.split(/(<a\b[^>]*>.*?<\/a>)/gs);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // inside an <a> — leave it
      return part.replace(PR_REF_IN_ESCAPED, (match, num) => {
        const href = `https://${host}/${repo.owner}/${repo.name}/issues/${num}`;
        return `<a href="${href}" class="pane-link" target="_blank" rel="noopener noreferrer">${match}</a>`;
      });
    })
    .join("");
}

function linkifyUrls(escaped) {
  return escaped.replace(URL_IN_ESCAPED, (match) => {
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

// Wrap viewable file paths in a span that the client turns into an in-app
// viewer trigger. Runs AFTER linkifyUrls and skips text already inside an <a>
// (so it never re-wraps a URL that happens to end in .png). The raw path is
// stored in a data attribute (un-escaped) for the fetch; the visible text keeps
// its escaping.
function linkifyFiles(html) {
  // Split on existing anchor tags so we don't touch their contents.
  const parts = html.split(/(<a\b[^>]*>.*?<\/a>)/gs);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // an <a>...</a> segment — leave it
      return part.replace(FILE_IN_ESCAPED, (match) => {
        const rawPath = unescapeHtmlEntities(match);
        const dataPath = escapeHtml(rawPath).replaceAll('"', "&quot;");
        return `<span class="pane-file" role="link" tabindex="0" data-file-path="${dataPath}">${match}</span>`;
      });
    })
    .join("");
}
