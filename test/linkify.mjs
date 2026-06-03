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

console.log("linkify unit tests passed");
