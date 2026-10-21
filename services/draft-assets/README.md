# Private Draft media

Agents upload binary files directly to the fixed `tmax-draft-assets` R2 bucket with
`public/skills/tmax-drafts/scripts/upload-asset.mjs`. The helper uses 16 MiB parts,
SHA-256 keys under a machine-specific prefix, verified size/hash metadata and
bounded memory. Credentials live only in each machine's private
`~/.config/tmux-mobile/draft-assets.json` (0600), separately from the public Skill.
A bucket-scoped R2 Object Read & Write credential is preferred; an existing
owner-approved R2 credential can be reused without changing its underlying scope.

The Controller validates asset references against the publishing machine. After
normal Draft read authorization it signs each managed URL for 24 hours. The Worker
checks the exact object path and expiry before serving bytes, supports HEAD and
single byte ranges, and never exposes bucket credentials. The private bucket's
r2.dev endpoint is disabled. Temporary read URLs remain usable until expiry;
refreshing the Draft refreshes them. Raw HTML downloads keep unsigned URLs.

Worker secret `READ_KEY` is hex HMAC-SHA256 of `tmax-draft-assets-v1` using the
Controller's `SESSION_SECRET`. Keep both out of source, screenshots and logs.
Rotating SESSION_SECRET also requires updating READ_KEY. No ECS task configuration
or Connector compatibility change is needed. Both Controller domains remain valid.

Provision/release the checked Worker with the local Cloudflare credential and
existing AWS Secrets Manager permission:

```sh
python3 scripts/provision-draft-assets.py --receipt-dir /private/receipt-directory
```

This creates the one bucket if missing, installs private local upload credentials,
deploys the Worker and attaches `draft-assets.xyznot.com`. It writes a private
short-lived super-admin cookie for fleet rollout; remove that cookie and the
private Worker test key after verification. Never put that receipt directory in Git.
It derives S3 credentials from the existing token; it does not grant new permission
or claim that an account-wide token has become bucket-scoped. Deploy Controller
changes with the repository's usual checked-image release procedure.

Run `node test/draft-assets.mjs`, `node test/drafts.mjs`, `node test/drafts-http.mjs`
and `npm run test:skills`. Verify real uploads, unsigned 403, signed GET/HEAD/ranges,
video metadata/playback and selected-text feedback before reporting success. Keep
published content-addressed objects so older Draft revisions remain usable.
