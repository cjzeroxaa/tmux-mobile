# Claude operating notes for this repo

## 1. eng.impo.ai is the canonical runtime

The deployed AWS Controller at `https://eng.impo.ai` is the browser/API entry
point. Local repository checkouts are for development, building, and publishing;
they are not a production gateway for the machine. Do not treat a local
`node server.mjs` address as special infrastructure, and do not add or maintain
Tailscale Serve mappings for this product.

The hosted Controller may use an internal container port as an implementation
detail. Users and connectors always address the public HTTPS Controller URL.
Each machine only needs its outbound Connector process.

## 2. Controller and Connector update runbook

Connector updates are production changes. Server deploys and connector deploys
are related but not the same thing:

- A server-only/UI/static change should not make machines update.
- A connector/protocol change should bump `CONNECTOR_COMPAT_VERSION` in
  `lib/protocol.mjs`; Command Center marks machines stale from missing ops or
  connector-version mismatch, not from raw git revision mismatch alone.
- Use a super-admin browser session/cookie when checking rollout state. A normal
  workspace user only sees their own/workspace machines and can miss machines
  like personal Gmail connectors.

Preferred flow for updating connectors one by one:

1. Deploy the controller first and verify it:
   ```bash
   curl -fsS https://eng.impo.ai/api/health | jq .
   ```

2. Get a super-admin-authenticated view of every machine. Either log in as a
   super-admin in the browser or create a short-lived cookie from the production
   `SESSION_SECRET` without printing the secret:
   ```bash
   SECRET="$(aws secretsmanager get-secret-value \
     --region us-east-1 \
     --secret-id tmux-mobile-controller/SESSION_SECRET \
     --query SecretString \
     --output text)"

   node --input-type=module - /tmp/tmux-mobile-prod-super-cookie.txt "$SECRET" <<'NODE'
   import fs from "node:fs";
   import { createHmac } from "node:crypto";
   const [out, secret] = process.argv.slice(2);
   const now = Math.floor(Date.now() / 1000);
   const body = Buffer.from(JSON.stringify({
     type: "session",
     userId: "sonicgg@gmail.com",
     email: "sonicgg@gmail.com",
     hd: "",
     iat: now,
     exp: now + 3600,
   })).toString("base64url");
   const sig = createHmac("sha256", secret).update(body).digest("base64url");
   fs.writeFileSync(
     out,
     `# Netscape HTTP Cookie File\neng.impo.ai\tFALSE\t/\tTRUE\t${now + 3600}\ttmux_mobile_session\t${body}.${sig}\n`,
   );
   NODE
   unset SECRET
   ```

3. Inspect all machines before touching anything:
   ```bash
   curl -fsS -b /tmp/tmux-mobile-prod-super-cookie.txt \
     https://eng.impo.ai/api/command-center \
     | jq -r '.machines[] | [.hostname, .ownerEmail, .agentRevision, .connectorVersion, .expectedConnectorVersion, .stale, .connectorStatus, .agentCwd] | @tsv'
   ```

4. Update exactly one stale machine at a time. Use the machine's routed `id` as
   `x-machine-id`; the controller starts a temporary `tmux-mobile-update-*`
   session on that machine and the bundle updater replaces/restarts the local
   connector:
   ```bash
   MACHINE="MSB-SRP"
   row="$(curl -fsS -b /tmp/tmux-mobile-prod-super-cookie.txt \
     https://eng.impo.ai/api/command-center \
     | jq -c --arg host "$MACHINE" '.machines[] | select(.hostname == $host)')"

   id="$(printf '%s' "$row" | jq -r .id)"
   body="$(printf '%s' "$row" | jq '{
     repoDir: (.agentCwd // "~/.local/share/tmux-mobile"),
     expectedRevision: (.expectedRevision // ""),
     targetRef: (.updateRef // "main"),
     updateScriptUrl: (.updateScriptUrl // "https://eng.impo.ai/connector/update.mjs"),
     nodePath: (.nodePath // "node"),
     agentMachine: (.machineAlias // .hostname // .machineId // ""),
     machineLabel: (.hostname // .machineId // ""),
     mux: (.mux // ""),
     muxes: "tmux,rmux"
   }')"

   curl -fsS -b /tmp/tmux-mobile-prod-super-cookie.txt \
     -H "content-type: application/json" \
     -H "x-machine-id: $id" \
     -X POST https://eng.impo.ai/api/connector-update \
     --data "$body" | jq .
   ```

5. Poll until that machine reconnects with `stale=false`,
   `connectorStatus=current`, and `connectorVersion` equal to
   `expectedConnectorVersion`:
   ```bash
   curl -fsS -b /tmp/tmux-mobile-prod-super-cookie.txt \
     https://eng.impo.ai/api/command-center \
     | jq -r --arg host "$MACHINE" '.machines[] | select(.hostname == $host) | [.hostname, .agentRevision, .connectorVersion, .expectedConnectorVersion, .stale, .connectorStatus, .agentCwd] | @tsv'
   ```

Repeat steps 4-5 for the next stale machine. It is normal for a machine to
briefly disappear while the old connector exits and the new one reconnects.
After the rollout, this command should show no stale machines:

```bash
curl -fsS -b /tmp/tmux-mobile-prod-super-cookie.txt \
  https://eng.impo.ai/api/command-center \
  | jq '[.machines[] | select(.stale == true)]'
```

Do not use raw `agentRevision` alone as the decision to update. For example,
after a server-only deploy some machines may report an older `agentRevision` but
still be healthy if `connectorVersion` is current and `stale=false`.

## 4. Pinned artifacts (lib/pins.mjs + lib/artifact-storage.mjs)

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
