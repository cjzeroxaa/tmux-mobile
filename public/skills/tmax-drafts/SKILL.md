---
name: tmax-drafts
description: Create and revise private, session-bound HTML deliverables in T-Max. Use for a reviewable PR explanation, interactive diagram, proposal or report, and when responding to selected-text comments on an existing Draft. Includes the PR Lens generation workflow for code diagrams.
---

# T-Max Drafts

Turn an explanation into one complete HTML page that the user can read, select text in, comment on, and revise with the same Agent. T-Max is the private Host. The Agent is the generator.

## Publishing boundary

Publish only to the user's T-Max Host, normally `https://eng.xyznot.com` (`https://eng.impo.ai` is the same service). The Host inherits the linked session's machine permissions. Do not publish to prlens.dev, the public impo.ai PR Lens site, GitHub PR comments, a public bucket, or any other hosting service unless the user separately asks for that destination. PR Lens is used for generation and rendering here; its normal public-sharing steps are replaced by the T-Max publish command below. This workflow does not use MCP.

## Generate

1. Establish the target session. If the user opened Drafts from a session card, use the supplied `kind` and `sessionId`. Otherwise run the client’s `context` command. It uses this machine's existing Connector login and `TMUX_PANE` to identify the current session. If multiple sessions remain, match the working directory and conversation; ask only when the binding is still ambiguous. Never publish against a guessed session ID.
2. Read the relevant source material. For a PR or code/system explanation, load [references/pr-lens.md](references/pr-lens.md), which includes the PR Lens generation workflow. For other tasks, generate ordinary HTML and use diagrams when they help explain the content.
3. Write one self-contained HTML file. Put the full explanation, diagrams and useful interactions in this page. Do not leave the essential explanation only in chat. Embed CSS, JavaScript, images and SVG; no CDN scripts, remote fonts, fetch calls, or sibling asset files. Include a meaningful `<title>`, `<body>` and closing `</html>`.
4. Preserve selectable DOM text: headings, explanations, diagram captions, labels and any conclusions should be readable as text. Provide an ordinary text explanation beside canvas/WebGL graphics. Do not disable text selection or cover the reading surface with a drag handler. Use a small “drag to pan” control when a diagram needs panning.
5. Use the [page starter](assets/page.html) when useful. Keep the existing Instant paper/forest style and automatic light/dark appearance. The Host supplies selected-text comments; do not build a competing comment UI in the generated file.
6. Save the file, then publish explicitly with the client. There is no Pin step or background directory scan. Open the returned private link and verify the page actually renders and its interactions work. Give the user that same stable link.

## Client

Download the small generation-side helper once:

```sh
curl -fsSL https://eng.xyznot.com/draft-client.mjs -o /tmp/tmax-draft-client.mjs
node /tmp/tmax-draft-client.mjs context
node /tmp/tmax-draft-client.mjs publish --kind codex --session SESSION_ID --file review.html
```

Replace the example kind/session with the actual context. For a custom Host, pass `--api https://your-host` to every call and download the helper from that same Host. The helper reads the existing local Connector login; do not print or copy the token, put it in HTML, or send it to PR Lens.

Publishing creates a sibling `review.html.draft.json` receipt with the Draft ID and revision. Keep the HTML filename and receipt for later edits: publishing the same session/filename updates the existing page. Different filenames create independent Drafts. The Host accepts HTML up to 5 MB; if the page is larger, simplify embedded assets without truncating the explanation.

## Read feedback and revise

```sh
node /tmp/tmax-draft-client.mjs comments --id DRAFT_ID
```

Read the current page and the open comments. Each comment includes the exact selected text, surrounding text and the version it refers to. If the quote has changed, inspect the surrounding content; do not replace unrelated text merely because it looks similar. Repeated text can be ambiguous.

Revise the same HTML file and publish it again. Keep unrelated content and useful interactions. Do not overwrite it with a short chat summary. Return the same Draft link and briefly say what changed. The user can comment again on that page. Comments remain until the user marks them handled; publishing alone does not mean every comment was resolved.

If publishing returns a version conflict, stop automatic retries. Read the latest version and feedback from the Host before merging your edit. After deliberately reconciling it, publish with `--version CURRENT_VERSION`. An identical retry after a lost response is safe and returns the existing version. A new filename is a new Draft, not a way to evade a conflict.

The Host currently refreshes on opening, manual refresh and returning to the tab. It does not repeatedly download an idle page. After an Agent publishes, the user can refresh to see the next version. Typing a comment keeps the current version on screen.
