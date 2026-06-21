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
// open in the in-app viewer; video/audio/html open in an external tab (the
// browser plays audio with native <audio> controls).
const VIEWABLE_FILE_EXTS =
  "png|jpe?g|gif|svg|webp|bmp|ico|md|markdown|mdown|mkd|webm|mp4|m4v|mov|wav|mp3|ogg|m4a|aac|flac|html?";

// Matches file paths ending in a viewable extension, in already-escaped text.
// Requires either a path separator or a leading ./ ../ ~/ so a bare word like
// "image" isn't matched, but "screenshot.png", "./out.png", "docs/guide.md",
// "/abs/path.md", and "~/notes.md" are.
//
// Wrapped paths: a long path the terminal wrapped onto the next line appears as
// `dir/<newline><indent>rest.md`. We allow a single newline + indentation to
// appear right AFTER a "/" (the only place a path realistically wraps), so the
// whole path is captured across the wrap; linkifyFiles strips the wrap from the
// stored data-path while keeping the visible text wrapped. A path segment is
// otherwise `[^\s...]` (stops at whitespace/quotes/brackets).
const SEG = String.raw`[^\s<>"'(){}\[\]:/]`;
const WRAP = String.raw`(?:\n[ \t]*)?`; // optional line-wrap continuation
const FILE_IN_ESCAPED = new RegExp(
  String.raw`(?:\.{0,2}\/|~\/)?(?:${SEG}+\/${WRAP})*${SEG}+\.(?:${VIEWABLE_FILE_EXTS})\b`,
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

// Matches the "#1234" of a "PR #1234" reference and wraps ONLY that token.
// Deliberately NOT bare "#1234" everywhere — that over-triggers on
// shell/markdown/diff text; the "PR " prefix is the trigger.
//
// The "PR" prefix is matched but kept OUTSIDE the link, because the pane HTML
// wraps each ANSI color run in <span>…</span> and an agent's status line often
// colors "PR" and "#1234" in SEPARATE spans (literal text:
// `PR</span> <span class="…">#1234`). Wrapping the whole "PR #1234" would put an
// <a> across a span boundary → invalid nesting. So we only wrap `#1234` (which
// lives inside a single span) and allow HTML tags / whitespace to sit between
// the "PR" trigger and the "#". The trigger is a non-captured prefix.
const TAG_OR_SPACE = "(?:<[^>]*>|\\s)";
// Group 1 = the prefix (PR + any tags/space) we re-emit unchanged; group 2 = the
// "#1234" token we turn into the link.
const PR_REF_IN_ESCAPED = new RegExp(
  `(\\bPR${TAG_OR_SPACE}*)(#${TAG_OR_SPACE}*\\d+)\\b`,
  "gi",
);

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
      return part.replace(PR_REF_IN_ESCAPED, (match, prefix, hashToken) => {
        // The "#1234" token must live within a single span, or wrapping it in an
        // <a> would cross a span boundary → invalid nesting. If the token itself
        // straddles markup (very rare: "#" and digits in different color runs),
        // leave it unlinked rather than emit broken HTML.
        if (/<\/?[a-z]/i.test(hashToken)) return match;
        const num = hashToken.replace(/\D+/g, "");
        const href = `https://${host}/${repo.owner}/${repo.name}/issues/${num}`;
        return `${prefix}<a href="${href}" class="pane-link" target="_blank" rel="noopener noreferrer">${hashToken}</a>`;
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

// Linkify viewable file paths in already-escaped text OR in rendered HTML
// (e.g. markdown output). Exported so the command-center cards can linkify
// rendered-markdown responses without also re-running URL linkification (which
// would corrupt the markdown's own <a href> / <img src> attributes).
export function linkifyFilesEscaped(html) {
  return linkifyFiles(String(html));
}

// Wrap viewable file paths in a span that the client turns into an in-app viewer
// trigger. Tag-safe: it only rewrites TEXT between tags, never tag internals
// (so it can't mangle an <img src="x.png"> attribute), and it skips text inside
// <a>…</a> (so it never re-wraps a URL that happens to end in .png). The raw path
// is stored in a data attribute (un-escaped) for the fetch; the visible text
// keeps its escaping.
function linkifyFiles(html) {
  // First peel off whole <a>…</a> segments and leave them untouched.
  return html
    .split(/(<a\b[^>]*>.*?<\/a>)/gs)
    .map((part, i) => {
      if (i % 2 === 1) return part; // an <a>...</a> segment — leave it
      // Within the rest, split on ANY tag so attribute values are never matched;
      // only the text tokens between tags get the file-path regex.
      return part
        .split(/(<[^>]+>)/)
        .map((token, j) => {
          if (j % 2 === 1) return token; // a tag — leave it
          return token.replace(FILE_IN_ESCAPED, (match) => {
            // The match may span a terminal line-wrap (a newline + indentation
            // right after a "/"). Strip that from the path used for the fetch,
            // but keep `match` (the visible text) so the pane still shows the wrap.
            const joined = match.replace(/\/\n[ \t]*/g, "/");
            const rawPath = unescapeHtmlEntities(joined);
            const dataPath = escapeHtml(rawPath).replaceAll('"', "&quot;");
            return `<span class="pane-file" role="link" tabindex="0" data-file-path="${dataPath}">${match}</span>`;
          });
        })
        .join("");
    })
    .join("");
}
