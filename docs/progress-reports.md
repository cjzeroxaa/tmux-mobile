# Progress reports

The controller builds hourly reports and daily rollups using Gemini. Web and
mobile expose **More → Progress reports** (`/reports`); mobile uses the existing
single-use browser handoff so the user keeps their identity.

- Timezone: Asia/Shanghai. An hour closes two minutes after the hour; the daily
  report runs after midnight, using the previous day's 24 saved hourly reports.
- Source: only user messages and assistant responses from newly committed
  transcript chunks. No terminal polling, fleet RPCs, or repeated archive scans.
  Historical catch-up older than one day is ignored. A finalized hour is not
  rewritten by late arrivals. The first report may cover only part of its hour.
- The commit callback performs no network calls. Compact journals flush once a
  minute when dirty, and on graceful shutdown. A hard crash can lose up to one
  minute of this summary input; the original transcript archive is unaffected.
- Journal files are separated by process and hour; identical source messages
  deduplicate across files. Each session retains at most 60 messages / 36K chars;
  each hour has a 4 MiB text budget and at most 500 sessions. Coverage limits are
  visible as a partial-report notice; original conversations remain available.
- Each Gemini call contains only sessions from a single machine (up to 8).
  Idle sessions are omitted. Prompts alone don't trigger generation. Quiet hours
  make no Gemini request. Model output is validated against input IDs and rendered
  as plain text. Clicking a session opens the original conversation.
- Reports and small journals use the existing private transcript storage under
  `reports-v1/`. Reports are immutable once ready. Existing machine permissions
  are evaluated on every read, including for offline machines and shared access.
  Listing uses period IDs only and paginates 50 reports at a time.
- A process single-flight guard and storage CAS claims prevent duplicate model
  work across overlapping ticks and rolling deploys. Claims last ten minutes;
  failed generation retries after 15 minutes, at most three attempts. Restarts
  catch up at most one day. Nothing is scheduled in the frontend.

## Configuration

`GEMINI_API_KEY` and optional `TMUX_MOBILE_REPORT_MODEL` configure local use.
Production uses `transcripts/reports-v1/config.enc.json` in the private transcript
bucket, encrypted with AES-256-GCM using a key derived from `SESSION_SECRET`,
plus S3 server-side encryption. Only the server decrypts it. No API returns this
object or its secret. This reuses existing task storage permissions and does not
require IAM or ECS task-definition changes. Re-provision the encrypted config
when rotating `SESSION_SECRET`; never put an API key in the image, repo or UI.

Configuration plaintext shape: `{ apiKey, model, collectingSince }`.
Envelope shape: `{ version: 1, iv, tag, data }`, with binary fields in base64;
key derivation is SHA-256 of `tmux-progress-reports\0${SESSION_SECRET}`.
`collectingSince` is an ISO timestamp and should be preserved on key rotation.
Model is currently `gemini-3.8-flash`. Missing/invalid configuration disables
reports without affecting transcript uploads or the rest of the controller.

Run `node test/progress-reports.mjs` for scheduler, restart, deduplication,
permissions, machine isolation, quiet-hour and failure-budget checks.
`test/e2e-controller.mjs` covers the authenticated reports page/browser handoff.
