# Claude operating notes for this repo

## Web release preference (2026-09-09)

For requested tmux-mobile Web changes, finish the implementation, run the
appropriate checks, then deploy to production and verify the live result without
waiting for a separate release request or confirmation. The user explicitly
authorized this workflow for the Web app. This preference does not authorize
automatic iOS/TestFlight releases.

## 1. eng.xyznot.com is the canonical runtime

Both `eng.xyznot.com` and `eng.impo.ai` are permanently supported entry points
to the same service. The old domain has no retirement date. Keep both domains'
DNS, TLS certificates (including renewal validation records), and Google OAuth
callbacks active. Do not redirect or remove either domain without an explicit
user request.

The deployed AWS Controller at `https://eng.xyznot.com` is the browser/API entry
point. Local repository checkouts are for development, building, and publishing;
they are not a production gateway for the machine. Do not treat a local
`node server.mjs` address as special infrastructure, and do not add or maintain
Tailscale Serve mappings for this product.

The hosted Controller may use an internal container port as an implementation
detail. Users and connectors always address the public HTTPS Controller URL.
Each machine only needs its outbound Connector process.

### Web production release path (verified from prior releases, 2026-09-09)

Use `scripts/push-image.sh` after checks. It builds a unique source image tag,
then calls `scripts/deploy-existing-task.py` to save the current image under a
rollback tag, update the mutable image tag already referenced by the live ECS
service, and call `update-service --force-new-deployment` on the same task
definition. It waits for rollout completion and checks the live revision on
both production domains and the running image digest; a failed rollout restores
the previous image. Selecting either production `--health-url` still checks
both domains.

This existing ECR/ECS release channel successfully published `b056ec4` and
`698fd75` before this runbook was corrected. At the 2026-09-09 preflight,
production used `tmux-mobile-controller:163` with deployment tag `626fbb7`;
always discover the current service definition and image tag instead of
hardcoding these values. The deployment tag is not the source revision.

`rebyte-prod` lacks PassRole for the two `tmux-mobile-controller-*` roles.
That prevents registering a new task definition, not application-only releases
through the existing definition. Do not repeatedly stop at that preflight or
request IAM changes for a normal Web release. Task configuration or role changes
are a separate operation; follow `../AWS_MANAGEMENT.md` for those.

For an already built and checked ECR image, run:

```bash
python3 scripts/deploy-existing-task.py \
  --source-tag <unique-source-tag> --expected-revision <embedded-revision> \
  --receipt-dir /tmp/tmux-mobile-deploy-<unique-release>
```

Add `--plan` for read-only preflight (use a separate receipt directory).
Confirm public `/api/health`, the deployed Web asset, and browser behavior.
Keep source and rollback tags. Do not update Connectors for a Web-only change.
For Connector updates, use the actual bundle manifest revision, since the
existing definition's `TMUX_MOBILE_EXPECTED_REVISION` can retain an old tag.

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
   curl -fsS https://eng.xyznot.com/api/health | jq .
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
     `# Netscape HTTP Cookie File\neng.xyznot.com\tFALSE\t/\tTRUE\t${now + 3600}\ttmux_mobile_session\t${body}.${sig}\n`,
   );
   NODE
   unset SECRET
   ```

3. Inspect all machines before touching anything:
   ```bash
   curl -fsS -b /tmp/tmux-mobile-prod-super-cookie.txt \
     https://eng.xyznot.com/api/command-center \
     | jq -r '.machines[] | [.hostname, .ownerEmail, .agentRevision, .connectorVersion, .expectedConnectorVersion, .stale, .connectorStatus, .agentCwd] | @tsv'
   ```

4. Update exactly one stale machine at a time. Use the machine's routed `id` as
   `x-machine-id`; the controller starts a temporary `tmux-mobile-update-*`
   session on that machine and the bundle updater replaces/restarts the local
   connector:
   ```bash
   MACHINE="MSB-SRP"
   row="$(curl -fsS -b /tmp/tmux-mobile-prod-super-cookie.txt \
     https://eng.xyznot.com/api/command-center \
     | jq -c --arg host "$MACHINE" '.machines[] | select(.hostname == $host)')"

   id="$(printf '%s' "$row" | jq -r .id)"
   body="$(printf '%s' "$row" | jq '{
     repoDir: (.agentCwd // "~/.local/share/tmux-mobile"),
     expectedRevision: (.expectedRevision // ""),
     targetRef: (.updateRef // "main"),
     updateScriptUrl: (.updateScriptUrl // "https://eng.xyznot.com/connector/update.mjs"),
     nodePath: (.nodePath // "node"),
     agentMachine: (.machineAlias // .hostname // .machineId // ""),
     machineLabel: (.hostname // .machineId // ""),
     mux: (.mux // ""),
     muxes: "tmux,rmux"
   }')"

   curl -fsS -b /tmp/tmux-mobile-prod-super-cookie.txt \
     -H "content-type: application/json" \
     -H "x-machine-id: $id" \
     -X POST https://eng.xyznot.com/api/connector-update \
     --data "$body" | jq .
   ```

5. Poll until that machine reconnects with `stale=false`,
   `connectorStatus=current`, and `connectorVersion` equal to
   `expectedConnectorVersion`:
   ```bash
   curl -fsS -b /tmp/tmux-mobile-prod-super-cookie.txt \
     https://eng.xyznot.com/api/command-center \
     | jq -r --arg host "$MACHINE" '.machines[] | select(.hostname == $host) | [.hostname, .agentRevision, .connectorVersion, .expectedConnectorVersion, .stale, .connectorStatus, .agentCwd] | @tsv'
   ```

Repeat steps 4-5 for the next stale machine. It is normal for a machine to
briefly disappear while the old connector exits and the new one reconnects.
After the rollout, this command should show no stale machines:

```bash
curl -fsS -b /tmp/tmux-mobile-prod-super-cookie.txt \
  https://eng.xyznot.com/api/command-center \
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

## Session Drafts (2026-10-18)

The new review workflow is Drafts, not manual pins. A generator writes a
HTML entry file with optional private managed static media and explicitly publishes it using
`public/draft-client.mjs`. The private Host stores bytes in artifact storage and
metadata/revisions/comments in the existing comments table under `tmax-drafts`
and `tmax-draft#<id>` namespaces. The client uses the existing Connector login;
this is independent of MCP and requires no Connector compatibility bump.

`public/skills/tmax-drafts/` is the generation Skill, including a PR Lens
generation guide, graph contract and example. Its publishing destination is
T-MAX only; do not inherit PR Lens's public publication steps. `/drafts` is the
Host UI and is available from the top bar and individual session cards.
Selected quotes retain their version and context. Missing/ambiguous quotes
must not be silently reattached. Idle pages never poll.

Run `node test/drafts.mjs` and `node test/drafts-http.mjs` for storage, concurrent
writes, idempotent publishing, permissions, real CLI/API integration and history.
The content iframe uses CSP sandboxing without same-origin capability.

### New-machine initialization is a complete configuration task

For every new or reinstalled T-MAX machine, follow
[`docs/new-machine-setup.md`](docs/new-machine-setup.md). A connected Connector or
installed agent CLI is not sufficient. Install all maintained T-MAX Skills for
Codex, Claude Code and Pi; install the owner-approved private global document;
create all three instruction symlinks; verify source hashes, link targets and
Connector health. Use `cj-setup` for baseline workstation preparation when
available, then complete the T-MAX checklist. Record missing authentication or
offline machines explicitly instead of reporting setup complete.

### Install the T-MAX Skills on machines

The authoritative Skills are checked in under `public/skills/tmax-drafts/`,
`public/skills/tmax-start-agent/`, `public/skills/tmax-config-agent/`, and
`public/skills/tmax-assign-task/`, and `public/skills/tmax-multi-agent/`.
`tmax-start-agent` creates named Claude/Codex/Pi sessions,
preserves shell aliases, handles folder trust and verifies readiness using tmux only.
`tmax-config-agent` operates an existing Claude/Codex/Pi terminal to change models
or settings and complete user-assisted login through observed menus.
`tmax-assign-task` clarifies user-authorized work, verifies a specific existing
agent window, delivers the handoff once and checks submission/acknowledgment.
`tmax-multi-agent` coordinates visible T-MAX worker sessions, isolated worktrees,
window-output monitoring, verified model/effort, history-preserving runtime
replacement, dependency handoffs and integration.
After changing any Skill, run `npm run build:skills` and commit the manifest with the
source. `npm run test:skills` checks it and tests the installer.

Install or update for all three agents on a machine without restarting them:

```sh
curl -fsSL https://eng.xyznot.com/skills/install.mjs -o /tmp/tmax-install-skills.mjs
node /tmp/tmax-install-skills.mjs
node /tmp/tmax-install-skills.mjs --verify
```

The installer verifies every source hash before writing, then reads the installed
files back. It installs to `~/.codex/skills`, `~/.claude/skills`, and
`~/.pi/agent/skills`, honoring `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and
`PI_CODING_AGENT_DIR`. `--skill tmax-start-agent --source public/skills/tmax-start-agent` installs one
Skill from a checkout; without `--skill`, the hosted installer installs every maintained Skill.
`--api` chooses a different Host. Existing unrelated files are preserved.
Codex can discover the Skill on its next turn; start a new Claude session if it
has not refreshed its Skill list, and use `/reload` in an existing Pi session.
Do not send these commands into a user's running coding-agent conversation.
Use a dedicated shell session on each online machine, verify its receipt, then
remove only that temporary session. Offline machines must be reported separately.

### Standing instruction: complete fleet synchronization inventory (2026-10-18)

Two categories must stay synchronized: repository-owned Skills and global instructions. Never omit the global instruction
files when reporting fleet configuration:

| Item | Authoritative source | Required entries on every machine |
| --- | --- | --- |
| `tmax-drafts` Skill and bundled references/assets | `public/skills/tmax-drafts/` in this repository | Codex, Claude Code and Pi Skill directories |
| `tmax-start-agent` Skill and its session helper | `public/skills/tmax-start-agent/` in this repository | Codex, Claude Code and Pi Skill directories |
| `tmax-config-agent` Skill | `public/skills/tmax-config-agent/` in this repository | Codex, Claude Code and Pi Skill directories |
| `tmax-assign-task` Skill | `public/skills/tmax-assign-task/` in this repository | Codex, Claude Code and Pi Skill directories |
| `tmax-multi-agent` Skill | `public/skills/tmax-multi-agent/` in this repository | Codex, Claude Code and Pi Skill directories |
| Shared global Agent instructions | `~/.config/agent-instructions/AGENTS.md` on the machine where the owner requests the edit | `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.pi/agent/AGENTS.md` must be symlinks to each machine's copy of the canonical file |

Honor `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `PI_CODING_AGENT_DIR`. A change to the
global instructions requires copying the updated canonical document to all
registered machines, backing up existing files, preserving or repairing the
three links, and reading back their content hashes and resolved targets. These
global files are separate from repository-local `AGENTS.md` / `CLAUDE.md`; do
not overwrite repository instructions with global instructions. Do not publish
private global instructions as unauthenticated Web assets.

For an all-machine sync, explicitly check and report both inventory items.
When only one changes, synchronize that item and report the other's status;
do not reinstall unchanged files unnecessarily. File and Skill synchronization
is authorized as part of either change. Use complete super-admin inventory,
temporary shell sessions, verified receipts and backups. Preserve active Agent
sessions and name offline or failed machines. Do not restart Connectors for
these file-only changes. New Agent sessions reliably load updated instructions.

### Skill publication procedure

The owner explicitly requires every future change to any repository-owned T-MAX Skill to be
published to **all T-MAX machines and all three coding agents: Codex, Claude
Code and Pi**. A local install, Git push, or Web release alone is not completion.
This fleet installation is authorized as part of each Skill change; do not ask
for the same approval again.

1. Keep the Skill and its bundled references in this repository. Rebuild its
   manifest, run `npm run test:skills`, commit and push the source.
2. Publish the matching hosted Skill files and installer. Preserve both domains.
3. Read the complete machine inventory using super-admin access. Run the installer
   on each online machine, including machines owned by the owner's other account.
   Run `scripts/install-fleet-skills.py --cookie-file <0600-cookie-header-file>
   --skill <skill-name> --receipts <private-directory>` for each Skill; unchanged
   files are verified without replacing them. `--local-installer` copies the checked-in
   installer through each Connector when needed; it still verifies its hash.
4. Require matching source hashes in the read-back receipts for Codex, Claude
   Code and Pi on every target. Preserve active sessions; use temporary shell
   sessions and clean them up. Do not restart Connectors just to install a Skill.
5. List offline, failed or unreachable machines explicitly. Retry transient
   failures and never claim the entire fleet is updated without receipts.
   Existing Pi sessions may need `/reload`; do not inject it into active work.

`AGENTS.md` links to this file, so this instruction applies to every coding agent
working in the repository.
