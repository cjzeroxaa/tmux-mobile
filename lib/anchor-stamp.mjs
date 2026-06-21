// Stamp a stable, content-derived `data-aid` onto each commentable block of a
// rendered (markdown) HTML document, so comments can anchor to a block by
// identity rather than position and re-anchor across versions. Ported from
// tdoc (github.com/serenakeyitan/tdoc) — same cyrb53 + aidFor + tag-walking
// stamper — with the attribute renamed to `data-aid` and prose tags (p, li,
// h1–h6) added so paragraphs/headings/list items are commentable too.

// cyrb53: fast, stable 53-bit string hash (base36). Same content ⇒ same aid.
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const RAW_TEXT_TAGS = ["script", "style", "textarea", "title"];

// Block elements we make commentable. Prose tags (p/li/h*) added vs tdoc so a
// paragraph/heading/list item can be tapped; the rest are media/structure.
const STAMPABLE_TAGS = [
  "p", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "pre", "blockquote", "table", "figure", "img", "svg", "video", "details",
];

function aidFor(tag, innerHtml, openAttrs) {
  const intrinsics = ["viewBox", "src", "alt", "aria-label", "title"]
    .map((a) => {
      const m = new RegExp("\\b" + a + '\\s*=\\s*"([^"]*)"', "i").exec(openAttrs || "");
      return m ? a + "=" + m[1] : "";
    })
    .filter(Boolean)
    .join("|");
  const norm = (innerHtml || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\sdata-aid\s*=\s*"[^"]*"/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cyrb53(tag + "|" + intrinsics + "|" + norm);
}

// Return the index just past the ">" of the open tag starting at `lt`, honoring
// quoted attribute values (so a ">" inside an attribute doesn't end it early).
function attrAwareOpenTagEnd(html, lt) {
  let quote = null;
  for (let i = lt + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i + 1;
  }
  return -1;
}

function skipRawTextBodyAt(html, openTag, attrs, openEnd) {
  if (!RAW_TEXT_TAGS.includes(openTag)) return null;
  if (/\/\s*$/.test(attrs)) return openEnd;
  const closeRe = new RegExp(`</${openTag}\\s*>`, "i");
  const m = closeRe.exec(html.slice(openEnd));
  return m ? openEnd + m.index + m[0].length : html.length;
}

// Stamp data-aid onto every stampable block. Returns { html, aids } where aids
// is metadata (aid, tag, head snippet, nearest heading) for a comments overview.
export function stampAids(rawHtml) {
  const html = String(rawHtml || "");
  const headRe = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const headings = [];
  let hmatch;
  while ((hmatch = headRe.exec(html))) {
    headings.push({
      end: hmatch.index + hmatch[0].length,
      text: hmatch[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    });
  }
  function nearestHeadingAt(idx) {
    let best = null;
    for (const h of headings) {
      if (h.end <= idx) best = h.text;
      else break;
    }
    return best;
  }

  const elements = [];
  const seenOpens = new Set();
  function harvest(openStart, openEnd, tagLower, attrs) {
    if (seenOpens.has(openStart)) return;
    const isVoid = /^(img|svg)$/i.test(tagLower) || /\/\s*$/.test(attrs);
    let closeEnd = openEnd;
    let innerHtml = "";
    if (!isVoid) {
      const openSameRe = new RegExp(`<${tagLower}\\b`, "gi");
      const closeSameRe = new RegExp(`</${tagLower}\\s*>`, "gi");
      const rawOpenRe = new RegExp(`<(${RAW_TEXT_TAGS.join("|")})\\b`, "gi");
      let depth = 1;
      let scan = openEnd;
      let foundCloseEnd = -1;
      while (scan < html.length) {
        closeSameRe.lastIndex = scan;
        openSameRe.lastIndex = scan;
        rawOpenRe.lastIndex = scan;
        const mc = closeSameRe.exec(html);
        const mo = openSameRe.exec(html);
        const mr = rawOpenRe.exec(html);
        const next = [mc, mo, mr].filter(Boolean).sort((a, b) => a.index - b.index)[0];
        if (!next) break;
        if (next === mr) {
          const rTag = mr[1].toLowerCase();
          const rEnd = attrAwareOpenTagEnd(html, mr.index);
          if (rEnd < 0) break;
          const skipTo = skipRawTextBodyAt(html, rTag, html.slice(mr.index, rEnd), rEnd);
          scan = skipTo != null ? skipTo : rEnd;
          continue;
        }
        if (next === mc) {
          depth--;
          if (depth === 0) {
            foundCloseEnd = mc.index + mc[0].length;
            break;
          }
          scan = mc.index + mc[0].length;
        } else {
          depth++;
          const oEnd = attrAwareOpenTagEnd(html, mo.index);
          scan = oEnd < 0 ? mo.index + mo[0].length : oEnd;
        }
      }
      if (foundCloseEnd >= 0) closeEnd = foundCloseEnd;
      innerHtml = html.slice(openEnd, closeEnd - `</${tagLower}>`.length);
    }
    seenOpens.add(openStart);
    elements.push({ openStart, openEnd, closeEnd, tag: tagLower, attrs, innerHtml, isVoid });
  }

  for (const tag of STAMPABLE_TAGS) {
    const openRe = new RegExp(`<${tag}\\b`, "gi");
    let m;
    while ((m = openRe.exec(html))) {
      const end = attrAwareOpenTagEnd(html, m.index);
      if (end < 0) continue;
      const attrs = html.slice(m.index + 1 + tag.length, end - 1);
      harvest(m.index, end, tag, attrs);
    }
  }

  const aids = [];
  for (const e of elements) {
    const cleanedAttrs = e.attrs.replace(/\s+data-aid\s*=\s*"[^"]*"/gi, "");
    const cleanedInner = e.innerHtml.replace(/\sdata-aid\s*=\s*"[^"]*"/gi, "");
    e._cleanedAttrs = cleanedAttrs;
    e._aid = aidFor(e.tag, cleanedInner, cleanedAttrs);
    aids.push({
      aid: e._aid,
      tag: e.tag,
      head: e.innerHtml.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 80),
      heading: nearestHeadingAt(e.openStart),
    });
  }

  // Apply stamps from the end backward so earlier offsets stay valid.
  elements.sort((a, b) => b.openStart - a.openStart);
  let out = html;
  for (const e of elements) {
    const selfClose = /\/\s*$/.test(e.attrs) ? "/" : "";
    const stampedOpen = `<${e.tag}${e._cleanedAttrs} data-aid="${e._aid}"${selfClose}>`;
    out = out.slice(0, e.openStart) + stampedOpen + out.slice(e.openEnd);
  }
  return { html: out, aids };
}

export { cyrb53, aidFor };
