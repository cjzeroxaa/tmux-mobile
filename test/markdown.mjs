// Unit test for the minimal Markdown renderer used by the content viewer.
// Focus: correct structure for common constructs AND safety (no raw HTML
// injection, no javascript: URLs).

import assert from "node:assert/strict";
import { renderMarkdown } from "../public/markdown.js";

// 1. headings
let h = renderMarkdown("# Title\n## Sub");
assert.ok(h.includes("<h1>Title</h1>"), "1 h1");
assert.ok(h.includes("<h2>Sub</h2>"), "1 h2");

// 2. bold + italic + inline code
h = renderMarkdown("a **bold** and *italic* and `code` end");
assert.ok(h.includes("<strong>bold</strong>"), "2 bold");
assert.ok(h.includes("<em>italic</em>"), "2 italic");
assert.ok(h.includes("<code>code</code>"), "2 code");

// 3. fenced code block escapes its contents
h = renderMarkdown("```\n<script>alert(1)</script>\n```");
assert.ok(h.includes("<pre class=\"md-code\"><code>"), "3 pre");
assert.ok(h.includes("&lt;script&gt;"), "3 escaped in code");
assert.ok(!h.includes("<script>"), "3 no raw script");

// 4. lists
h = renderMarkdown("- one\n- two");
assert.ok(h.includes("<ul>") && h.includes("<li>one</li>") && h.includes("<li>two</li>"), "4 ul");
h = renderMarkdown("1. a\n2. b");
assert.ok(h.includes("<ol>") && h.includes("<li>a</li>"), "4 ol");

// 5. safe link
h = renderMarkdown("[site](https://example.com)");
assert.ok(h.includes('href="https://example.com"'), "5 link href");
assert.ok(h.includes('rel="noopener noreferrer"'), "5 link rel");

// 6. javascript: link is neutralized (rendered as text, no href)
h = renderMarkdown("[x](javascript:alert(1))");
assert.ok(!h.includes("javascript:"), `6 no js url: ${h}`);
assert.ok(!h.includes("<a "), "6 no anchor for js url");

// 7. raw HTML in markdown body is escaped, not executed
h = renderMarkdown("hello <img src=x onerror=alert(1)> world");
assert.ok(!h.includes("<img src=x"), `7 no raw img: ${h}`);
assert.ok(h.includes("&lt;img"), "7 escaped img");

// 8. blockquote + hr
h = renderMarkdown("> quoted\n\n---");
assert.ok(h.includes("<blockquote>quoted</blockquote>"), "8 blockquote");
assert.ok(h.includes("<hr />"), "8 hr");

// 9. image with safe src
h = renderMarkdown("![alt](https://example.com/a.png)");
assert.ok(h.includes('<img alt="alt" src="https://example.com/a.png"'), `9 img: ${h}`);

console.log("markdown unit tests passed");
