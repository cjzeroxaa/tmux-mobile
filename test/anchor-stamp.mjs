// Unit tests for the block anchor stamper (lib/anchor-stamp.mjs).
import assert from "node:assert/strict";
import { stampAids, aidFor } from "../lib/anchor-stamp.mjs";

// Paragraphs, heading, code, list, image all get a data-aid.
const html = [
  "<h1>Title</h1>",
  "<p>First paragraph.</p>",
  "<p>Second paragraph.</p>",
  "<pre><code>code &lt;here&gt;</code></pre>",
  "<ul><li>one</li><li>two</li></ul>",
  '<p><img src="/a/b.png" alt="pic"></p>',
  "<blockquote><p>quoted</p></blockquote>",
].join("\n");

const { html: out, aids } = stampAids(html);

assert.match(out, /<h1 data-aid="[a-z0-9]+">Title<\/h1>/, "heading stamped");
assert.equal((out.match(/<p data-aid="/g) || []).length, 4, "all paragraphs stamped (incl. img p + blockquote p)");
assert.match(out, /<pre data-aid="/, "pre stamped");
assert.match(out, /<li data-aid="[a-z0-9]+">one<\/li>/, "list item stamped");
assert.match(out, /<img src="\/a\/b.png" alt="pic" data-aid="/, "img stamped (void)");
assert.match(out, /<blockquote data-aid="/, "blockquote stamped");

// Same content → same aid (stable across renders/versions).
const a1 = aidFor("p", "Hello world", "");
const a2 = aidFor("p", "Hello world", "");
assert.equal(a1, a2, "aid is stable for identical content");
// Different content → different aid.
assert.notEqual(aidFor("p", "Hello world", ""), aidFor("p", "Goodbye", ""));
// Different tag → different aid.
assert.notEqual(aidFor("p", "x", ""), aidFor("h1", "x", ""));

// Two identical-text paragraphs collide on aid (same content = same anchor) —
// acceptable: a comment on identical content re-anchors to either; this matches
// tdoc's content-identity model.
const dup = stampAids("<p>same</p><p>same</p>");
const dupAids = [...dup.html.matchAll(/data-aid="([a-z0-9]+)"/g)].map((m) => m[1]);
assert.equal(dupAids[0], dupAids[1], "identical paragraphs share an aid (content identity)");

// Re-stamping already-stamped HTML is idempotent (aids recomputed from cleaned
// content, not doubled).
const again = stampAids(out);
assert.equal((again.html.match(/data-aid="/g) || []).length, (out.match(/data-aid="/g) || []).length,
  "re-stamp does not duplicate data-aid");

// aids metadata carries heading context.
assert.ok(aids.find((a) => a.tag === "p" && a.heading === "Title"), "aids include nearest heading");

console.log("anchor-stamp unit tests passed");
