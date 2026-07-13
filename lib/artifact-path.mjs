// Helpers for turning agent-authored file references into paths we can read.
// Agents often emit paths inside markdown/backticks or with sentence punctuation
// attached. Keep the original candidate first; cleaned candidates are fallbacks.

const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const HTML_ENTITIES = [
  ["&quot;", '"'],
  ["&#034;", '"'],
  ["&#34;", '"'],
  ["&#039;", "'"],
  ["&#39;", "'"],
  ["&apos;", "'"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&amp;", "&"],
];

const SENTENCE_TAIL_RE = /[.,;:!?。，、；：！？…]+$/u;
const DANGLING_CLOSER_RE = /[\])}>」』”’）》】]+$/u;
const WRAPPER_PAIRS = [
  ["`", "`"],
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["<", ">"],
  ["（", "）"],
  ["【", "】"],
  ["「", "」"],
  ["『", "』"],
  ["《", "》"],
];

function decodeCommonHtmlEntities(value) {
  let out = String(value);
  for (const [entity, char] of HTML_ENTITIES) {
    out = out.replaceAll(entity, char);
  }
  return out;
}

function stripOuterWrappers(value) {
  let out = String(value).trim();
  let changed = true;
  while (changed && out.length >= 2) {
    changed = false;
    for (const [open, close] of WRAPPER_PAIRS) {
      if (out.startsWith(open) && out.endsWith(close)) {
        out = out.slice(open.length, out.length - close.length).trim();
        changed = true;
        break;
      }
    }
  }
  return out;
}

function stripCodeFence(value) {
  let out = String(value).trim();
  out = out.replace(/^```[A-Za-z0-9_-]*[ \t]*(?:\r?\n)?/, "");
  out = out.replace(/(?:\r?\n)?```$/g, "");
  return out.trim();
}

function stripMarkdownLink(value) {
  const out = String(value).trim();
  const match = out.match(/^!?\[[^\]\n]*\]\(([\s\S]+)\)$/);
  if (!match) return out;
  let target = match[1].trim();
  if (target.startsWith("<")) {
    const close = target.indexOf(">");
    if (close > 0) return target.slice(1, close).trim();
  }
  const titled = target.match(/^([^"' \t\r\n][\s\S]*?)\s+["'][\s\S]*["']$/);
  if (titled) target = titled[1].trim();
  return target;
}

function stripFileUrl(value) {
  const out = String(value).trim();
  if (!/^file:\/\//i.test(out)) return out;
  try {
    const url = new URL(out);
    return decodeURIComponent(url.pathname || "");
  } catch {
    return out.replace(/^file:\/\//i, "");
  }
}

export function cleanArtifactPath(value) {
  let out = String(value || "")
    .replace(ANSI_ESCAPE_RE, "")
    .replace(/\/\r?\n[ \t]*/g, "/")
    .trim();
  if (!out) return "";

  for (let i = 0; i < 6; i += 1) {
    const before = out;
    out = stripCodeFence(out);
    out = decodeCommonHtmlEntities(out);
    out = out.replace(SENTENCE_TAIL_RE, "").trim();
    out = stripMarkdownLink(out);
    out = stripOuterWrappers(out);
    out = stripFileUrl(out);
    out = out.replace(SENTENCE_TAIL_RE, "").trim();
    out = out.replace(DANGLING_CLOSER_RE, "").trim();
    out = stripOuterWrappers(out);
    if (out === before) break;
  }

  return out;
}

function tryDecodeUri(value) {
  try {
    const decoded = decodeURI(value);
    return decoded === value ? "" : decoded;
  } catch {
    return "";
  }
}

export function artifactPathCandidates(value) {
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    const next = String(candidate || "").trim();
    if (!next || seen.has(next)) return;
    seen.add(next);
    candidates.push(next);
  };

  const raw = String(value || "").trim();
  add(raw);

  const cleaned = cleanArtifactPath(raw);
  add(cleaned);
  add(tryDecodeUri(cleaned));

  const noFragment = cleaned.split(/[?#]/, 1)[0];
  if (noFragment !== cleaned) {
    add(noFragment);
    add(cleanArtifactPath(noFragment));
    add(tryDecodeUri(noFragment));
  }

  return candidates;
}
