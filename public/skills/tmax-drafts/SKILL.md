---
name: tmax-drafts
description: Create and revise private, session-bound HTML deliverables in T-Max. Use for a reviewable PR explanation, mathematical explanation, interactive diagram, proposal or report, and when responding to selected-text comments on an existing Draft. Includes PR Lens code diagrams and Manim math animations.
---

# T-Max Drafts

Turn an explanation into one complete HTML page that the user can read, select text in, comment on, and revise with the same Agent. T-Max is the private Host. The Agent is the generator.

## Publishing boundary

Publish only to the user's T-Max Host, normally `https://eng.xyznot.com` (`https://eng.impo.ai` is the same service). The Host inherits the linked session's machine permissions. Do not publish to prlens.dev, the public impo.ai PR Lens site, GitHub PR comments, a public bucket, or any other hosting service unless the user separately asks for that destination. The dedicated private `tmax-draft-assets` R2 bucket is the approved destination for this workflow’s static media, using the bundled uploader below. PR Lens is used for generation and rendering here; its normal public-sharing steps are replaced by the T-Max publish command below. This workflow does not use MCP.

## Generate

1. Establish the target session. If the user opened Drafts from a session card, use the supplied `kind` and `sessionId`. Otherwise run the client’s `context` command. It uses this machine's existing Connector login and `TMUX_PANE` to identify the current session. If multiple sessions remain, match the working directory and conversation; ask only when the binding is still ambiguous. Never publish against a guessed session ID.
2. Read the relevant source material. For a PR or code/system explanation, load [references/pr-lens.md](references/pr-lens.md), which includes the PR Lens generation workflow. For mathematical explanations, load [references/manim.md](references/manim.md). Prefer Manim Community animations when motion makes a derivation, geometric relationship or changing quantity easier to understand; keep simple static formulas in selectable HTML. For other tasks, generate ordinary HTML and use diagrams when they help explain the content.
3. Write one HTML entry file. Put the full explanation, diagrams and useful interactions in this page. Do not leave the essential explanation only in chat. Embed CSS, JavaScript, small icons and SVG diagrams. Upload video, audio, large images and downloadable files with the bundled asset helper and reference its returned URL. Never base64-embed audio/video or large binary files. No CDN scripts, remote fonts, fetch calls, or sibling asset paths. Include a meaningful `<title>`, `<body>` and closing `</html>`.
4. Preserve selectable DOM text: headings, explanations, diagram captions, labels and any conclusions should be readable as text. Provide an ordinary text explanation beside canvas/WebGL graphics. Do not disable text selection or cover the reading surface with a drag handler. Use a small “drag to pan” control when a diagram needs panning.
5. Use the [page starter](assets/page.html) when useful. Keep the existing Instant paper/forest style and automatic light/dark appearance. The Host supplies selected-text comments; do not build a competing comment UI in the generated file.
6. Use a short English filename such as `pr-review.html`; keep URL paths and link labels in English. The document itself may use the user’s language. Save the file, then publish explicitly with the client. There is no Pin step or background directory scan. Open the returned private link and verify the page actually renders and its interactions work. Give the user that same stable link.

## Client

Download the small generation-side helper once:

```sh
curl -fsSL https://eng.xyznot.com/draft-client.mjs -o /tmp/tmax-draft-client.mjs
node /tmp/tmax-draft-client.mjs context
node /tmp/tmax-draft-client.mjs publish --kind codex --session SESSION_ID --file review.html
```

Replace the example kind/session with the actual context. For a custom Host, pass `--api https://your-host` to every call and download the helper from that same Host. The helper reads the existing local Connector login; do not print or copy the token, put it in HTML, or send it to PR Lens.

Publishing creates a sibling `review.html.draft.json` receipt with the Draft ID and revision. Keep the HTML filename and receipt for later edits: publishing the same session/filename updates the existing page. Different filenames create independent Drafts. The Host accepts HTML up to 5 MB; media bytes live separately and do not count toward this limit. Move large embedded files to the asset bucket without truncating the explanation.

## Static images, audio, video and downloads

Use `scripts/upload-asset.mjs` from **this installed Skill directory**. The example
below uses the default Codex location; Claude Code/Pi use the same bundled script
in their own Skill directory. Honor custom agent roots.

```sh
node ~/.codex/skills/tmax-drafts/scripts/upload-asset.mjs --file /absolute/path/demo.mp4
```

The helper reads the existing Connector login to identify this machine and reads
R2 upload credentials from `~/.config/tmux-mobile/draft-assets.json` (mode `0600`).
`TMAX_DRAFT_ASSET_CONFIG` or `--credentials` may select a private configuration path;
`--api` selects the same custom T-Max Host as the publish client. Credentials are
provisioned separately from the public Skill. Do not paste them in shell commands,
HTML, receipts, comments, Git, or logs. If missing, report the missing provisioning
step; do not fall back to base64 or publish elsewhere.

The fixed deployment is Cloudflare account `34431cd51da281ed3590ab6ce5141d09`,
bucket `tmax-draft-assets`, asset origin `https://draft-assets.xyznot.com`.
The uploader uses bounded-memory multipart upload, verifies the object, deduplicates
unchanged content, and returns JSON with `url`, `sha256`, `bytes`, and `contentType`.
Keep the returned URL exactly as written; do not invent paths or add credentials.
For example, put that URL in `<video controls preload="metadata" src="RETURNED_URL"></video>`
or `<img src="RETURNED_URL" alt="...">`. Use an ordinary `<a href="RETURNED_URL">`
for downloads. Upload changed files again; their content hashes create new URLs and
preserve old Draft revisions. Do not delete assets during routine cleanup.

Publish the HTML through the normal Draft client. After checking the viewer's Draft
access, the Host adds temporary read signatures to managed asset URLs. The R2 bucket
stays private, and raw unsigned URLs are not public links. Read signatures expire
after 24 hours; refresh the Draft to renew them. These temporary links can be reused
until expiry, so avoid sharing them separately. A downloaded raw HTML file retains
unsigned URLs and needs the T-Max Host for media access. Video seeking uses byte
ranges, so a 300 MB MP4 does not need to be downloaded in full before playback.

Verify image loading or actual video metadata/playback in the published Draft, plus
selected-text comments. An upload success alone does not prove rendering or playback.

## Read feedback and revise

```sh
node /tmp/tmax-draft-client.mjs comments --id DRAFT_ID
```

Read the current page and the open comments. Each comment includes the exact selected text, surrounding text and the version it refers to. If the quote has changed, inspect the surrounding content; do not replace unrelated text merely because it looks similar. Repeated text can be ambiguous.

Revise the same HTML file and publish it again. Keep unrelated content and useful interactions. Do not overwrite it with a short chat summary. Return the same Draft link and briefly say what changed. The user can comment again on that page. Comments remain until the user marks them handled; publishing alone does not mean every comment was resolved.

If publishing returns a version conflict, stop automatic retries. Read the latest version and feedback from the Host before merging your edit. After deliberately reconciling it, publish with `--version CURRENT_VERSION`. An identical retry after a lost response is safe and returns the existing version. A new filename is a new Draft, not a way to evade a conflict.

The Host currently refreshes on opening, manual refresh and returning to the tab. It does not repeatedly download an idle page. After an Agent publishes, the user can refresh to see the next version. Typing a comment keeps the current version on screen.
