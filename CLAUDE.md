# Claude operating notes for this repo

## 1. The 127.0.0.1:3737 server is the gateway for this whole machine

`node server.mjs` listening on `127.0.0.1:3737` is **SUPER important**. It is
the single way the human reaches this Mac from their phone (and from anywhere
else). If this server is down, the machine is effectively unreachable. Treat
every operation that touches it as production.

## 2. The setup is intentionally simple: one Node process + Tailscale Serve

There is no launchd, no systemd, no Docker, no process manager. Don't add one.
The whole thing is:

- `node server.mjs` running in the foreground / a background shell, bound to
  `127.0.0.1:3737`. Started from the repo checkout with `npm start`
  (or `node server.mjs` directly).
- Tailscale Serve fronts it on the tailnet:
  `https://<your-machine>.<your-tailnet>.ts.net:<port>`  →  `http://127.0.0.1:3737`
  (Check live mapping with `tailscale serve status`.)

That's it. Don't "improve" this by installing a LaunchAgent, writing a wrapper
script, or anything similar unless the human explicitly asks. Keep it boring.

## 3. Pinned artifacts (lib/pins.mjs + lib/artifact-storage.mjs)

Tapping a viewable file (image/markdown/HTML/media) in the pane snapshot opens a
viewer page that can **pin** the artifact: its current bytes are snapshotted into
artifact storage and get a stable, shareable link (`/pin?token=…`, with `/api/pin`
kept as an alias) that keeps
working even if the origin machine goes offline. Pins are **content-addressed**
(sha256): re-pinning unchanged content dedups; changed content makes a new version
in the same "family" (owner + source machine + path). Each pin has a share scope
(private / specific users / all logged-in users), enforced per request against the
authenticated viewer. "Pinned artifacts" in the More menu lists/manages them.

- Pin index = mutable metadata records, kept SEPARATE from the bytes in a
  pluggable backend (`lib/pin-index.mjs`), selected by `TMUX_MOBILE_PIN_INDEX`:
  - `memory` (default): ephemeral, zero infra — local/Tailscale single-process.
  - `file`: local `~/.config/tmux-mobile/pins.json` (override
    `TMUX_MOBILE_PINS_CONFIG`); durable on a real box, best-effort on read-only home.
  - `firestore` (`@google-cloud/firestore`, optionalDependency): ONE document per
    pin (collection `TMUX_MOBILE_PIN_COLLECTION`, default `pins`; database
    `TMUX_MOBILE_FIRESTORE_DATABASE`, default `(default)`). Per-document
    upsert/delete — no whole-file rewrite, naturally concurrent-safe. Auth via ADC
    / the Cloud Run runtime SA (needs `roles/datastore.user`).
  - Records are sanitized on read in `lib/pins.mjs`. Index reads are async, so
    `listPins`/`getPinById`/`getPinByToken`/`servePin` are async. If the backend
    fails to init, the server falls back to an in-memory index (pinning degrades
    to ephemeral rather than crashing).
  - NOTE: an earlier version stored the whole index as one `index/pins.json` blob
    in the artifact storage driver — that was replaced by this per-record index
    because a single blob rewrites on every change and races concurrent writers.
- Storage driver selected by `TMUX_MOBILE_ARTIFACT_STORAGE`:
  - `local` (default): writes to `TMUX_MOBILE_ARTIFACT_DIR` or
    `~/.local/share/tmux-mobile/artifacts`. **Zero new infra — this is the boring
    default.** The serve route streams the bytes.
  - `s3`: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (optionalDependency).
    Env: `TMUX_MOBILE_S3_BUCKET`, `TMUX_MOBILE_S3_REGION`, optional
    `TMUX_MOBILE_S3_ENDPOINT` (R2/MinIO), `TMUX_MOBILE_S3_KEY_PREFIX`; creds via the
    AWS default chain.
  - `gcs`: `@google-cloud/storage` (optionalDependency). Env:
    `TMUX_MOBILE_GCS_BUCKET`, optional `TMUX_MOBILE_GCS_KEY_PREFIX`; auth via ADC /
    workload identity / `GOOGLE_APPLICATION_CREDENTIALS`.
  - Cloud drivers serve via a **presigned-redirect** (TTL
    `TMUX_MOBILE_PRESIGN_TTL_SECONDS`, default 300). Note: an issued presigned URL
    stays valid until it expires even after a scope change/unpin — short TTL bounds
    that window. Markdown `?view=1` always proxies so the server can render it.
- The cloud SDKs are **optionalDependencies** and imported lazily. If a cloud
  driver fails to init (SDK missing / bad creds), the server logs it and **falls
  back to the local driver** rather than failing to boot. On Cloud Run, prefer a
  cloud driver so artifacts survive instance recycling.
