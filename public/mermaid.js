// Lazy Mermaid loader + renderer for the content viewer. Mermaid (~2.8MB) is
// imported from a CDN only the first time a markdown file actually contains a
// ```mermaid block, so it costs nothing for non-diagram files and keeps the repo
// dependency-free. Rendered with securityLevel:'strict' so a diagram definition
// from an untrusted file can't inject HTML/script or wire up click handlers.

const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

let mermaidPromise = null; // cache the import+init so we load mermaid once

function loadMermaid() {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = import(/* @vite-ignore */ MERMAID_CDN)
    .then((mod) => {
      const mermaid = mod.default || mod;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict", // no HTML labels, no click events
        theme: matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "default",
      });
      return mermaid;
    })
    .catch((error) => {
      mermaidPromise = null; // allow a retry on a later open
      throw error;
    });
  return mermaidPromise;
}

let renderSeq = 0;

// Upgrade every <pre class="mermaid-block" data-mermaid="pending"> inside the
// container into a rendered SVG. Each block is independent: a failure in one
// leaves its source text visible and doesn't block the others. Returns a promise
// that resolves once all blocks have been attempted.
export async function renderMermaidIn(container) {
  if (!container) return;
  const blocks = [...container.querySelectorAll('pre.mermaid-block[data-mermaid="pending"]')];
  if (!blocks.length) return;

  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    for (const block of blocks) {
      block.dataset.mermaid = "error";
      block.title = "Mermaid could not be loaded (offline?). Showing diagram source.";
    }
    return;
  }

  await Promise.all(
    blocks.map(async (block) => {
      // textContent is the raw, un-escaped diagram source (the browser decoded
      // the entities we escaped server-side/in the renderer).
      const source = block.textContent;
      const id = `mermaid-svg-${(renderSeq += 1)}`;
      try {
        const { svg } = await mermaid.render(id, source);
        const figure = document.createElement("div");
        figure.className = "mermaid-rendered";
        figure.innerHTML = svg; // mermaid output; strict mode forbids embedded HTML/script
        block.replaceWith(figure);
      } catch (error) {
        // Leave the source visible; mark it so it's styled as a failed block.
        block.dataset.mermaid = "error";
        block.title = `Mermaid render failed: ${error?.message || "invalid diagram"}`;
      }
    }),
  );
}

// True if the rendered markdown HTML contains at least one mermaid block, so the
// caller can decide whether to bother importing this path at all.
export function hasMermaid(html) {
  return /class="mermaid-block"/.test(String(html));
}
