# T-Max terminal sharing

Production viewer and relay: **https://share.xyznot.com**.

The T-Max Controller authenticates the owner and creates a share. The Connector
opens an outbound WebSocket directly to our Cloudflare Worker. The Worker routes
each random session ID to its own `TTYSession` Durable Object. A browser connects
to that same object. Terminal traffic does not pass through the AWS Controller.

The relay state machine and binary framing are adapted from
[jiayx/shello](https://github.com/jiayx/shello), commit `17366a2`. The original
checkout lives at `/Users/homo/src/shello`. We provide our own viewer, tmux bridge,
authentication, deployment, and hosting. No upstream hosted service, bootstrap,
agent binaries, analytics, or tunnel service is used.

## Behavior

- Share buttons appear on session cards and in the terminal window list.
- The Web creation dialog enables control by default; uncheck it for a view-only
  link. Existing links retain their permissions. One viewer can hold control at
  a time; disconnect releases it.
- A separate signed host capability cannot be derived from a viewer link. Link
  creation requires the Controller's service key. Roles, session IDs and expiry
  are covered by HMAC; the fragment keeps the viewer credential out of page URLs
  sent by normal navigation. WebSocket/API calls carry it in their query string;
  Worker request logging is disabled.
- Shares default to 24 hours, with 5-day and 7-day options (maximum 7 days). Unexpected host disconnection has a
  three-minute reconnect grace.
- Stop sharing revokes the link and detaches only the sharing client. Connector
  restart also ends its shares. Original tmux sessions/processes stay alive.
- A tmux control-mode client exists only while viewers are connected. It uses
  `ignore-size`, attaches by session ID without switching the selected window,
  and filters output to the one authorized pane. No polling or `pipe-pane`.
- Hidden browser tabs disconnect. Returning reconnects with a fresh screen.
  Terminal dimensions follow the original machine; a small screen can scroll.
- Short terminals align with the bottom of the viewer. Taller terminals follow
  output in both the outer page viewport and xterm's scrollback. Scrolling up
  pauses following until the viewer returns to the bottom.
- Initial snapshots include 500 lines of tmux scrollback; viewers can choose
  100, 500, 1,000, 2,000 or 5,000. This is the machine's retained terminal buffer,
  not the archived Agent transcript. Subsequent output is pushed without polling.
- A viewer holding control can pick/drop/paste files. Files stream in acknowledged
  64 KiB chunks into the existing Connector temp-file writer, with no total-size
  cap. Losing control or disconnecting cancels partial uploads. Completed paths
  appear in an editable field; Insert path pastes without submitting Enter.
- On phones, take control then tap **Keyboard**, or tap the terminal. The toolbar
  sends Esc, Tab, Ctrl-C, arrows and Enter as terminal bytes, preserving focus.
  **Ctrl + Shift + Enter** takes or releases control without sending Enter into
  the terminal. Read-only links and another viewer's control remain protected.
  Changing the expiry requires stopping the existing share and creating a new link.
- RMUX retains its existing share implementation.

## Checks

```sh
npm ci
npm run build
npm test
npx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler \
  --lib es2022,dom --types @cloudflare/workers-types --skipLibCheck src/worker.ts src/viewer.ts
# From the repository root, requires local tmux:
npm run test:terminal-share
node test/terminal-share-upload.mjs
# Manual live integration with the actual local Backend, using a private key file:
TMAX_SHARE_CREATE_KEY_FILE=/private/path/key node test/terminal-share-live.mjs
```

`test/terminal-share.mjs` creates and destroys its own isolated tmux server.
The DO tests exercise persisted lifecycle, role restrictions, read-only input
rejection, revocation, disconnection and hibernation. Production canaries should
use a dedicated temporary shell, never a user's active Agent session.

## Release

Cloudflare account `34431cd51da281ed3590ab6ce5141d09`; Worker
`tmax-terminal-share`; Durable Object binding `TTY_SESSION`, class `TTYSession`.
The custom domain is provisioned through the account's Workers Domains API.
`wrangler.jsonc` records it; do not change either T-Max Controller domain.

Set Worker secret `CREATE_KEY` to hex HMAC-SHA256 with the Controller's
`SESSION_SECRET` as key and `tmax-terminal-share-v1` as message. Never store either
secret in source or expose the host capability in Controller responses. Rotation
must update the Worker as well and invalidates existing share links.

With Cloudflare credentials in the environment:

```sh
npm run deploy
```

The release script uploads an immutable Worker version and deploys that version
at 100%. It preserves existing custom-domain routing and does not need zone-wide
Workers Routes permission. For first-time provisioning only, `wrangler deploy`
creates the namespace/migration; attach the custom domain using the account
Workers Domains API when the token cannot list Zone Workers Routes.

Deploy the Controller using `scripts/push-image.sh`, then update Connectors to
compatibility **31**, one machine at a time, following the root runbook. Check
both Controller domains, the Worker health endpoint, and a real share. Roll back
the Controller with its saved ECR tag and the Worker with a prior immutable
version. Existing nonsharing Connector operations remain compatible.
