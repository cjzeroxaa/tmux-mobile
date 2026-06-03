// Minimal, dependency-free, safe-by-default Markdown -> HTML renderer for the
// content viewer. Not CommonMark-complete; covers the constructs that show up in
// READMEs and notes: headings, bold/italic/code, fenced code blocks, links,
// images, lists, blockquotes, hr, paragraphs. All text is HTML-escaped first, so
// raw HTML in the source is shown as text (no injection). Inline links/images
// are only emitted for http(s)/relative targets — never javascript: URLs.

import { escapeHtml } from "./linkify.js";

function safeUrl(raw) {
  const url = String(raw).trim();
  // Block javascript:, data: (except images handled separately), vbscript:, etc.
  if (/^\s*(javascript|vbscript|file):/i.test(url)) return "";
  return url;
}

function renderInline(text) {
  // Operate on already-escaped text. Order matters: code spans first so their
  // contents aren't further formatted.
  let s = escapeHtml(text);

  // Inline code `...`
  s = s.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);

  // Images ![alt](src)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_m, alt, src) => {
    const url = safeUrl(unescapeAttr(src));
    if (!url) return _m;
    return `<img alt="${alt}" src="${url.replaceAll('"', "%22")}" />`;
  });

  // Links [text](href)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_m, label, href) => {
    const url = safeUrl(unescapeAttr(href));
    if (!url) return label;
    return `<a href="${url.replaceAll('"', "%22")}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // Bold **...** / __...__
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  // Italic *...* / _..._
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_]+)_/g, "$1<em>$2</em>");

  return s;
}

function unescapeAttr(value) {
  return String(value).replaceAll("&amp;", "&").replaceAll("&#039;", "'").replaceAll("&quot;", '"');
}

// Split a GitHub-flavored table row into cells. Leading/trailing pipes are
// optional; a backslash-escaped pipe (\|) is a literal, not a separator.
function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cur = "";
  for (let j = 0; j < trimmed.length; j += 1) {
    const ch = trimmed[j];
    if (ch === "\\" && trimmed[j + 1] === "|") {
      cur += "|"; // literal pipe
      j += 1;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

// A delimiter row is the second line of a table: each cell is dashes with
// optional leading/trailing alignment colons (e.g. ---, :--, --:, :-:). Returns
// per-column alignment ("left" | "right" | "center" | null), or null if the line
// isn't a valid delimiter row.
function parseTableDelimiter(line) {
  if (!/\|/.test(line) && !/^\s*:?-+:?\s*$/.test(line)) return null;
  const cells = splitTableRow(line);
  if (!cells.length || cells.some((c) => !/^:?-+:?$/.test(c))) return null;
  return cells.map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

// True if `line` could start a table (has a pipe and isn't a fenced block etc.)
// and `next` is a delimiter row. Tables need both rows to be recognized.
function isTableStart(line, next) {
  if (next == null || !/\|/.test(line)) return false;
  return parseTableDelimiter(next) !== null;
}

export function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let i = 0;
  let listType = null; // "ul" | "ol" | null

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block ```
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      closeList();
      const lang = fence[1].trim().toLowerCase();
      const code = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing fence
      const body = code.join("\n");
      if (lang === "mermaid") {
        // Emit a container the client upgrades to a rendered diagram (mermaid is
        // lazy-loaded only when such a block exists). The escaped source is kept
        // so it degrades to readable text if rendering fails or is unavailable.
        html.push(
          `<pre class="mermaid-block" data-mermaid="pending">${escapeHtml(body)}</pre>`,
        );
      } else {
        html.push(`<pre class="md-code"><code>${escapeHtml(body)}</code></pre>`);
      }
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList();
      html.push("<hr />");
      i += 1;
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      closeList();
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      html.push(`<blockquote>${renderInline(quote.join(" "))}</blockquote>`);
      continue;
    }

    // Table (GitHub-flavored): a header row, a delimiter row, then body rows.
    if (isTableStart(line, lines[i + 1])) {
      closeList();
      const aligns = parseTableDelimiter(lines[i + 1]);
      const headers = splitTableRow(line);
      const alignAttr = (n) =>
        aligns[n] ? ` style="text-align:${aligns[n]}"` : "";
      const rows = [];
      i += 2; // consume header + delimiter
      while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      const out = ['<table class="md-table">', "<thead>", "<tr>"];
      headers.forEach((h, n) => {
        out.push(`<th${alignAttr(n)}>${renderInline(h)}</th>`);
      });
      out.push("</tr>", "</thead>", "<tbody>");
      for (const row of rows) {
        out.push("<tr>");
        // Pad/truncate to the header column count so ragged rows still render.
        for (let n = 0; n < headers.length; n += 1) {
          out.push(`<td${alignAttr(n)}>${renderInline(row[n] || "")}</td>`);
        }
        out.push("</tr>");
      }
      out.push("</tbody>", "</table>");
      html.push(out.join(""));
      continue;
    }

    // List items
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      const wantType = ul ? "ul" : "ol";
      if (listType !== wantType) {
        closeList();
        listType = wantType;
        html.push(`<${listType}>`);
      }
      html.push(`<li>${renderInline((ul ? ul[1] : ol[1]).trim())}</li>`);
      i += 1;
      continue;
    }

    // Blank line
    if (/^\s*$/.test(line)) {
      closeList();
      i += 1;
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-special lines
    closeList();
    const para = [line];
    i += 1;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !isTableStart(lines[i], lines[i + 1])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    html.push(`<p>${renderInline(para.join(" "))}</p>`);
  }

  closeList();
  return html.join("\n");
}
