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

// 10. a ```mermaid block becomes a mermaid container (not a plain code block),
//     with its source escaped and a pending marker for the client to upgrade.
h = renderMarkdown("```mermaid\ngraph TD; A-->B;\n```");
assert.ok(h.includes('class="mermaid-block"'), `10 mermaid container: ${h}`);
assert.ok(h.includes('data-mermaid="pending"'), "10 pending marker");
assert.ok(h.includes("graph TD; A--&gt;B;"), `10 source escaped (no raw -->): ${h}`);
assert.ok(!h.includes("md-code"), "10 not a normal code block");

// 11. a regular (non-mermaid) code block is still a normal code block
h = renderMarkdown("```python\nprint('hi')\n```");
assert.ok(h.includes('<pre class="md-code">'), "11 normal code block");
assert.ok(!h.includes("mermaid-block"), "11 not mermaid");

// 12. mermaid source with HTML/script is escaped (no injection via diagram text)
h = renderMarkdown("```mermaid\n<script>alert(1)</script>\n```");
assert.ok(h.includes("&lt;script&gt;"), "12 mermaid source escaped");
assert.ok(!h.includes("<script>"), "12 no raw script in mermaid block");

// 13. GitHub-flavored table: header + delimiter + body rows
h = renderMarkdown("| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |");
assert.ok(h.includes('<table class="md-table">'), `13 table: ${h}`);
assert.ok(h.includes("<thead>") && h.includes("<th>Name</th>") && h.includes("<th>Age</th>"), "13 header cells");
assert.ok(h.includes("<tbody>") && h.includes("<td>Alice</td>") && h.includes("<td>30</td>"), "13 body cells");
assert.ok(h.includes("<td>Bob</td>"), "13 second row");

// 14. column alignment from delimiter colons
h = renderMarkdown("| L | C | R |\n| :-- | :-: | --: |\n| a | b | c |");
assert.ok(h.includes('<th style="text-align:left">L</th>'), `14 left: ${h}`);
assert.ok(h.includes('<th style="text-align:center">C</th>'), "14 center");
assert.ok(h.includes('<th style="text-align:right">R</th>'), "14 right");
assert.ok(h.includes('<td style="text-align:center">b</td>'), "14 body cell aligned");

// 15. inline formatting inside cells; leading/trailing pipes optional
h = renderMarkdown("Name | Note\n--- | ---\n**bold** | `code`");
assert.ok(h.includes("<strong>bold</strong>"), `15 inline bold in cell: ${h}`);
assert.ok(h.includes("<code>code</code>"), "15 inline code in cell");

// 16. ragged rows are padded to the header width (no missing <td>)
h = renderMarkdown("| A | B | C |\n| - | - | - |\n| 1 |");
const row16 = h.slice(h.indexOf("<tbody>"));
assert.equal((row16.match(/<td/g) || []).length, 3, `16 ragged row padded to 3 tds: ${h}`);

// 17. escaped pipe (\|) inside a cell is a literal, not a column separator
h = renderMarkdown("| Expr | Val |\n| - | - |\n| a \\| b | 1 |");
assert.ok(h.includes("<td>a | b</td>"), `17 escaped pipe literal: ${h}`);

// 18. a normal pipe in prose (no delimiter row) is NOT a table
h = renderMarkdown("this | that is just text");
assert.ok(!h.includes("<table"), `18 not a table without delimiter: ${h}`);
assert.ok(h.includes("<p>"), "18 stays a paragraph");

// 19. cell content is escaped (no HTML injection through a table)
h = renderMarkdown("| X |\n| - |\n| <img src=x onerror=alert(1)> |");
assert.ok(!h.includes("<img src=x"), `19 no raw img in cell: ${h}`);
assert.ok(h.includes("&lt;img"), "19 escaped in cell");

console.log("markdown unit tests passed");
