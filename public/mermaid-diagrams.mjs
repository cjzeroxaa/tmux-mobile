let renderer;
let nextId = 0;
const requestedDiagrams = new Set();
async function loadRenderer() {
  renderer ||= import("https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs")
    .then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default", suppressErrorRendering: true });
      return mermaid;
    }).catch(error => { renderer = null; throw error; });
  return renderer;
}

export function addMermaidButtons(root) {
  for (const source of root.querySelectorAll('pre.mermaid-block[data-mermaid="pending"]')) {
    source.dataset.mermaid = "ready";
    const text = source.textContent;
    const wrapper = document.createElement("div");
    wrapper.className = "cc-diagram";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "small-button cc-diagram-render";
    button.textContent = "Render diagram";
    const diagram = document.createElement("div");
    diagram.className = "cc-diagram-image";
    diagram.hidden = true;
    const status = document.createElement("span");
    status.className = "cc-diagram-status";
    status.setAttribute("role", "status");
    source.replaceWith(wrapper);
    wrapper.append(button, status, source, diagram);
    button.addEventListener("click", async () => {
      if (diagram.childElementCount) {
        diagram.hidden = !diagram.hidden;
        source.hidden = !diagram.hidden;
        button.textContent = diagram.hidden ? "Show diagram" : "Show source";
        return;
      }
      requestedDiagrams.add(text);
      if (requestedDiagrams.size > 128) requestedDiagrams.delete(requestedDiagrams.values().next().value);
      button.disabled = true;
      status.textContent = "Rendering…";
      try {
        const mermaid = await loadRenderer();
        if (!wrapper.isConnected) return;
        const { svg } = await mermaid.render(`cc-mermaid-${++nextId}`, text);
        if (!wrapper.isConnected) return;
        diagram.innerHTML = svg;
        diagram.hidden = false;
        source.hidden = true;
        button.textContent = "Show source";
        status.textContent = "";
      } catch (error) {
        status.textContent = `Could not render: ${error.message || "try again"}`;
      } finally {
        button.disabled = false;
      }
    });
    // Incremental machine loads and sorting can replace card DOM while a render
    // is in flight. Preserve the user's request on the replacement block.
    if (requestedDiagrams.has(text)) queueMicrotask(() => {
      if (wrapper.isConnected) button.click();
    });
  }
}
