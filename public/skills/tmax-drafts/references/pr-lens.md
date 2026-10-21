# PR Lens generation inside T-Max Drafts

This is the generation-side PR Lens workflow adapted to the user's private T-Max Host. It includes the graph contract and a complete reference document locally; the upstream renderer remains `@coldtea/pr-lens-cli` (MIT, Coldtea). Do not invoke its `canvas push`, public `POST /api/prs`, or PR-comment publishing steps in this workflow.

1. Read the diff against the merge base, or inspect the actual source for a system explanation. Explain the concrete behavior change, why it exists, and the relevant unchanged neighbors.
2. Read [pr-lens/example.graph.json](pr-lens/example.graph.json) and consult [pr-lens/graph-document.md](pr-lens/graph-document.md) for the graph schema. Write `.pr-lens/graph.json` with lanes, nodes, edges and any useful ordered flows. Keep IDs stable and include source references. Do not invent findings/risk fields; put analysis in the HTML prose.
3. Validate and render locally:

```sh
npx @coldtea/pr-lens-cli@latest validate .pr-lens/graph.json
npx @coldtea/pr-lens-cli@latest render .pr-lens/graph.json --theme dark
```

Fix validation failures before rendering. Read the manifest to find the generated SVG paths. If a newer CLI needs a newer graph contract, load its generation references with `npx @coldtea/pr-lens-cli@latest skill references`; keep the T-Max private-publishing boundary in effect.

4. Inline the SVG markup into the final HTML. Do not reference a local SVG filename or an external iframe. Embed the full explanation, a short guided walkthrough, and the diagrams in the same page. A walkthrough step can reveal a section or highlight a diagram element; it should explain one concrete change. Make controls keyboard-operable and keep the explanation readable without animation. For multiple diagrams, prefix SVG IDs and their internal references to avoid collisions.
5. Use the T-Max Draft client to publish the **HTML**, not the graph JSON, to the bound session. Continue with selected-text feedback through that same Host.

This borrows PR Lens's separation between generation and hosting. It is not a claim that T-Max implements the PR Lens Canvas API: PR Lens transports graph JSON, while this Host stores an HTML entry file with optional private managed media, plus session identity, revisions and text-selection comments.
