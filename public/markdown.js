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
      const code = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing fence
      html.push(`<pre class="md-code"><code>${escapeHtml(code.join("\n"))}</code></pre>`);
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
      !/^\s*>\s?/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    html.push(`<p>${renderInline(para.join(" "))}</p>`);
  }

  closeList();
  return html.join("\n");
}
