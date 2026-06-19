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

// 20. LOOSE ordered list (blank lines between items) is ONE <ol> numbered
//     1,2,3 — not three separate <ol>s each restarting at 1 (the reported bug).
h = renderMarkdown("1. First\n\n2. Second\n\n3. Third");
assert.equal((h.match(/<ol/g) || []).length, 1, `20 single <ol> for loose list: ${h}`);
assert.equal((h.match(/<li>/g) || []).length, 3, "20 three items in one list");
assert.ok(/<li>First<\/li>[\s\S]*<li>Second<\/li>[\s\S]*<li>Third<\/li>/.test(h), "20 items in order");

// 21. ordered list not starting at 1 carries a start attribute
h = renderMarkdown("3. three\n4. four");
assert.ok(h.includes('<ol start="3">'), `21 start attr: ${h}`);

// 22. a list starting at 1 has NO start attribute (clean default)
h = renderMarkdown("1. a\n2. b");
assert.ok(h.includes("<ol>") && !h.includes("start="), `22 no start for 1: ${h}`);

// 23. nested list: deeper-indented items nest inside the parent item
h = renderMarkdown("1. Top\n   - sub a\n   - sub b\n2. Next");
assert.ok(/<li>Top[\s\S]*<ul>[\s\S]*<li>sub a<\/li>[\s\S]*<li>sub b<\/li>[\s\S]*<\/ul>[\s\S]*<\/li>/.test(h), `23 nested ul inside li: ${h}`);
assert.equal((h.match(/<li>Next<\/li>/g) || []).length, 1, "23 sibling Next stays at top level");

// 24. continuation line (indented, no marker) folds into the current item, not a
//     stray top-level paragraph
h = renderMarkdown("1. First item\n   continues here\n2. Second item");
assert.equal((h.match(/<ol/g) || []).length, 1, `24 single list despite continuation: ${h}`);
assert.ok(h.includes("continues here"), "24 continuation kept");

// 25. task list renders real (disabled) checkboxes, checked/unchecked
h = renderMarkdown("- [ ] todo\n- [x] done");
assert.ok(h.includes('<input type="checkbox" disabled /> todo'), `25 unchecked box: ${h}`);
assert.ok(h.includes('<input type="checkbox" disabled checked /> done'), "25 checked box");

// 26. strikethrough
h = renderMarkdown("~~gone~~ stays");
assert.ok(h.includes("<del>gone</del>"), `26 strikethrough: ${h}`);

// 27. bare URL autolinking, with trailing sentence punctuation kept OUTSIDE the link
h = renderMarkdown("see https://example.com here.");
assert.ok(h.includes('<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>'), `27 bare url linked: ${h}`);
h = renderMarkdown("(visit https://example.com).");
assert.ok(h.includes(">https://example.com</a>") && !h.includes("example.com).</a"), `27b trailing ). outside link: ${h}`);

// 28. a bare URL inside inline code is NOT autolinked (code is protected)
h = renderMarkdown("run `curl https://example.com` now");
assert.ok(h.includes("<code>curl https://example.com</code>"), `28 url in code not linked: ${h}`);
assert.ok(!/<code>[^<]*<a /.test(h), "28 no anchor inside code");

// 29. unordered + ordered remain distinct adjacent lists (no merge)
h = renderMarkdown("- a\n- b\n\n1. x\n2. y");
assert.ok(h.includes("<ul>") && h.includes("<ol>"), `29 both list types: ${h}`);

// 30. lightweight LaTeX rendering for inline and display math
h = renderMarkdown("设 $K$ 和 $\\mathbb{Z}$, $x^p$\n\n$$\\sigma(xy)=x^p y^p$$");
assert.ok(h.includes('class="md-math md-math-inline"'), `30 inline math: ${h}`);
assert.ok(h.includes("ℤ"), `30 mathbb rendered: ${h}`);
assert.ok(h.includes("x<sup>p</sup>"), `30 superscript rendered: ${h}`);
assert.ok(h.includes('class="md-math md-math-display"'), `30 display math: ${h}`);
assert.ok(h.includes("σ(xy)=x<sup>p</sup> y<sup>p</sup>"), `30 sigma display: ${h}`);

// 31. code spans stay literal and math contents stay escaped
h = renderMarkdown("`$K$` and $\\text{<img src=x>}$");
assert.ok(h.includes("<code>$K$</code>"), `31 code span literal: ${h}`);
assert.ok(h.includes("&lt;img src=x&gt;"), `31 math HTML escaped: ${h}`);
assert.ok(!h.includes("<img src=x>"), `31 no raw HTML from math: ${h}`);

console.log("markdown unit tests passed");
