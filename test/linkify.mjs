// Unit test for the pane URL linkifier (public/linkify.js). Imports the real
// shipped module so the test is bound to the actual implementation app.js uses.

import assert from "node:assert/strict";
import { escapeHtml, linkifyEscaped } from "../public/linkify.js";

const render = (t) => linkifyEscaped(escapeHtml(t));

// 1. plain http url -> anchor with matching href + display
let out = render("see https://example.com/path here");
assert.ok(out.includes('href="https://example.com/path"'), "1 href");
assert.ok(out.includes(">https://example.com/path</a>"), "1 display");

// 2. trailing sentence period stays outside the link
out = render("visit https://example.com.");
assert.ok(out.includes('href="https://example.com"'), `2 trims period: ${out}`);
assert.ok(out.endsWith("</a>."), "2 period outside");

// 3. query string '&' is escaped to &amp; in display but raw '&' in href
out = render("https://x.com/a?b=1&c=2");
assert.ok(out.includes('href="https://x.com/a?b=1&c=2"'), `3 raw href: ${out}`);
assert.ok(out.includes("&amp;c=2</a>"), `3 escaped display: ${out}`);

// 4. www. is prefixed with https:// in the href
out = render("go to www.example.org now");
assert.ok(out.includes('href="https://www.example.org"'), `4 www prefix: ${out}`);

// 5. no false positive on plain text; HTML in the pane stays escaped (no XSS)
out = render("text with <script>alert(1)</script> and no url");
assert.ok(!out.includes("<a "), "5 no link created");
assert.ok(out.includes("&lt;script&gt;"), "5 html stays escaped");
assert.ok(!out.includes("<script>"), "5 no raw script tag");

// 6. wrapping parens: closing paren stays outside the link
out = render("(https://example.com)");
assert.ok(out.includes('href="https://example.com"'), `6 paren href: ${out}`);
assert.ok(out.endsWith("</a>)"), "6 paren outside");

// 7. multiple urls on one line both linkified
out = render("a http://one.test b http://two.test c");
assert.equal((out.match(/<a /g) || []).length, 2, "7 two links");

// 8. a URL embedding a quote can't break out of the href attribute
out = render('http://e.com/"onmouseover="x');
assert.ok(!out.includes('"onmouseover="x"'), `8 no attribute breakout: ${out}`);

// 9. links carry safe rel + target
out = render("https://example.com");
assert.ok(out.includes('rel="noopener noreferrer"'), "9 rel");
assert.ok(out.includes('target="_blank"'), "9 target");

// --- file path detection (smart content viewer) ---

// 10. a relative image path becomes a pane-file span with the raw path
out = render("saved screenshot to ./out/shot.png done");
assert.ok(out.includes('class="pane-file"'), `10 file span: ${out}`);
assert.ok(out.includes('data-file-path="./out/shot.png"'), `10 data path: ${out}`);
assert.ok(out.includes(">./out/shot.png</span>"), "10 display");

// 11. a markdown path with a subdir
out = render("see docs/guide.md for details");
assert.ok(out.includes('data-file-path="docs/guide.md"'), `11 md path: ${out}`);

// 12. a bare word ending in .png with no separator is NOT matched (too noisy)
out = render("the value is image then more");
assert.ok(!out.includes("pane-file"), "12 no false positive on plain word");

// 13. a non-viewable extension is not matched
out = render("edit config/app.json now");
assert.ok(!out.includes("pane-file"), `13 json not viewable: ${out}`);

// 14. a URL ending in .png stays a URL, not a file span (no double-wrap)
out = render("open https://example.com/a.png now");
assert.ok(out.includes('href="https://example.com/a.png"'), "14 url href");
assert.ok(!out.includes("pane-file"), `14 url not re-wrapped as file: ${out}`);

// 15. absolute and ~/ paths
out = render("wrote /tmp/diagram.svg and ~/notes.md");
assert.ok(out.includes('data-file-path="/tmp/diagram.svg"'), `15 abs path: ${out}`);
assert.ok(out.includes('data-file-path="~/notes.md"'), `15 home path: ${out}`);

// 16. file-span path attribute is not injectable
out = render('x"><img src=x onerror=alert(1)>.png');
assert.ok(!out.includes("<img src=x"), `16 no html injection: ${out}`);

// 17. media + html paths are detected (these open in an external tab)
for (const p of ["./demo.webm", "out/clip.mp4", "render/report.html", "~/v.mov"]) {
  out = render(`made ${p} ok`);
  assert.ok(out.includes(`data-file-path="${p}"`), `17 detects ${p}: ${out}`);
}

// 17b. audio paths are detected too (open in an external tab; browser plays them
// with native <audio> controls). Kept in sync with server EXTERNAL_EXTS.
for (const p of ["./tone.wav", "out/voice.mp3", "clips/a.ogg", "~/rec.m4a", "x/y.aac", "d/s.flac"]) {
  out = render(`saved ${p} now`);
  assert.ok(out.includes(`data-file-path="${p}"`), `17b detects audio ${p}: ${out}`);
}

// --- PR reference linking (needs an active-window repo) ---
const repo = { host: "github.com", owner: "acme", name: "widget" };
const renderRepo = (t) => linkifyEscaped(escapeHtml(t), { repo });

// 18. "PR #1234" -> github issues link (auto-redirects to the PR). Only the
// "#1234" token is wrapped (so the link can't straddle ANSI <span> boundaries);
// the "PR" prefix stays outside the anchor.
out = renderRepo("landed in PR #4877 today");
assert.ok(
  out.includes('href="https://github.com/acme/widget/issues/4877"'),
  `18 PR link: ${out}`,
);
assert.ok(out.includes(">#4877</a>"), `18 display text: ${out}`);
assert.ok(out.includes("PR <a "), `18 PR prefix kept outside anchor: ${out}`);

// 19. "PR#1234" (no space) also matches
out = renderRepo("see PR#12");
assert.ok(out.includes("/issues/12"), `19 PR no-space: ${out}`);

// 20. bare "#1234" is NOT linked (too noisy)
out = renderRepo("comment #4877 and item #3");
assert.ok(!out.includes("<a "), `20 bare # not linked: ${out}`);

// 20a. PR ref split across ANSI color spans (the common statusline case:
// "PR" and "#1234" colored separately) still links, with VALID nesting — the
// <a> must not cross a </span> boundary. Regression for an agent statusline
// rendering "PR #5024" as two spans.
out = linkifyEscaped(
  '<span class="c1">PR</span> <span class="c2">#5024</span> for agents',
  { repo },
);
assert.ok(out.includes("/issues/5024"), `20a span-split links: ${out}`);
const crossesSpan = /<a\b[^>]*>(?:(?!<\/a>).)*<\/span>(?:(?!<\/a>).)*<\/a>/s.test(out);
assert.ok(!crossesSpan, `20a anchor must not cross a span boundary: ${out}`);

// 20b. a "#" split from its digits across spans is left UNLINKED rather than
// emitting broken markup.
out = linkifyEscaped('PR <span>#</span><span>5024</span>', { repo });
assert.ok(!out.includes("<a "), `20b hash-split not linked: ${out}`);

// 21. without a repo, "PR #1234" is left as plain text
out = render("PR #4877 with no repo");
assert.ok(!out.includes("<a "), `21 no repo -> no link: ${out}`);

// 22. a non-github host is honored
out = linkifyEscaped(escapeHtml("PR #5"), { repo: { host: "git.example.com", owner: "o", name: "r" } });
assert.ok(out.includes('href="https://git.example.com/o/r/issues/5"'), `22 custom host: ${out}`);

// 23. a path wrapped across lines (newline + indent after a "/") -> the
//     data-file-path joins to the full path, while the display keeps the wrap.
out = render("see docs/design/\n  runtimeclass-tool-capability-validation.md ok");
let dp = (out.match(/data-file-path="([^"]+)"/) || [])[1];
assert.equal(dp, "docs/design/runtimeclass-tool-capability-validation.md", `23 wrapped joins: ${dp}`);
assert.ok(out.includes("docs/design/\n"), "23 display keeps the wrap");

// 24. multi-segment wrap
out = render("a/very/\n   deep/\n   path/file.png x");
dp = (out.match(/data-file-path="([^"]+)"/) || [])[1];
assert.equal(dp, "a/very/deep/path/file.png", `24 multi-wrap: ${dp}`);

// 25. ~ wrapped
out = render("~/worktrees/kernel/\n  main/AGENTS.md");
dp = (out.match(/data-file-path="([^"]+)"/) || [])[1];
assert.equal(dp, "~/worktrees/kernel/main/AGENTS.md", `25 ~ wrapped: ${dp}`);

// 26. a "/" at end of a line followed by unrelated text must NOT glue
out = render("cd some/dir/\nsome random words here");
assert.ok(!out.includes("pane-file"), `26 no false glue: ${out}`);

console.log("linkify unit tests passed");
