# Set up a new T-Max machine

A new or reinstalled machine is ready only when its Connector, all maintained
T-Max Skills and the shared global instructions are installed and verified.
Installing the agent CLIs or connecting the Connector alone is not completion.
Apply this checklist on macOS and Linux, including the owner's other accounts.

## 1. Identify and prepare the machine

Confirm the intended host, OS, user account, home directory and repository paths.
Inspect existing agent configuration and active sessions before making changes.
Use the `cj-setup` Skill, when available, for the baseline workstation and normal
tmux workspace. Install the required Claude Code, Codex and Pi runtimes using
their supported methods; installing a binary and signing in are separate steps.
Do not copy another machine's credential directories or interrupt active agents.

Connect the machine to the existing T-Max Controller through the repository's
normal Connector onboarding flow. Verify its machine ID, name, owner, online
state and compatible Connector version in the complete authorized inventory.
`https://eng.xyznot.com` is canonical; `https://eng.impo.ai` remains supported.
Do not create a new Controller or a separate Rmax/Rmux workspace for this setup.

## 2. Install all maintained T-Max Skills

The source of truth is `public/skills/` and `supportedSkills` in the repository's
installer. Use its default install-all behavior instead of a frozen subset:

```sh
curl -fsSL https://eng.xyznot.com/skills/install.mjs -o /tmp/tmax-install-skills.mjs
node /tmp/tmax-install-skills.mjs
node /tmp/tmax-install-skills.mjs --verify
```

As of 2026-10-20, the inventory is:

| Skill | Purpose |
| --- | --- |
| `tmax-start-agent` | Create an agent in a named T-Max session/window and chosen directory |
| `tmax-config-agent` | Configure models/settings or complete interactive login |
| `tmax-assign-task` | Clarify and deliver a task to a verified existing agent window |
| `tmax-drafts` | Create and revise private session-bound deliverables |

Install every maintained Skill for **Codex, Claude Code and Pi**, even when only
one agent is used first. The installer checks source and installed-file hashes,
honors custom agent roots, and preserves unrelated local files. Run it in a
normal shell, not by typing shell commands into an agent conversation.

## 3. Install the shared private instructions

The Skill installer does **not** install global instructions. This is a separate
required operation.

Obtain the latest owner-approved `~/.config/agent-instructions/AGENTS.md` from an
already verified machine through authorized SSH or the authenticated T-Max file
channel. Record its source and SHA-256. Do not invent a replacement document,
copy an old repository-local file, or fetch private instructions from a public
Skill URL. If no authoritative copy is available, report this step as pending.

On the target:

1. Resolve the user's home and the three agent roots below. Expand a leading `~/`
   in an overridden root. Do not assume every machine uses `/Users/homo`.
2. Inspect and back up the existing canonical document and each destination,
   preserving both original content and symlink destinations. If either changes
   during setup, re-read it before replacing it. Preserve repository instructions.
3. Write the approved document to `~/.config/agent-instructions/AGENTS.md` using a
   temporary file and atomic replacement. Keep private copies/backups private.
4. Create or repair each agent's link to that machine's canonical document:

| Agent | Root (honor override) | Required link |
| --- | --- | --- |
| Codex | `CODEX_HOME`, default `~/.codex` | `<root>/AGENTS.md` |
| Claude Code | `CLAUDE_CONFIG_DIR`, default `~/.claude` | `<root>/CLAUDE.md` |
| Pi | `PI_CODING_AGENT_DIR`, default `~/.pi/agent` | `<root>/AGENTS.md` |

All three entries must be symlinks to the same local canonical file. The Claude
filename is `CLAUDE.md`, not `Cloud.md`. Do not use three independently edited
copies. Updating the canonical document must update what all three agents read.
Never publish the private document or an encoded copy as an unauthenticated asset.

## 4. Verify and hand over

- Confirm the intended Connector is online and compatible.
- Run the Skill installer's `--verify` and check every maintained Skill in all
  three agent roots against the current repository manifests.
- Verify the canonical instruction hash matches the approved source. Inspect
  each link, its resolved target and its content hash; checking only that the
  filenames exist is insufficient.
- Confirm every required CLI can start. Report authentication separately; do not
  claim an agent is logged in from a successful install/version check.
- Keep a compact receipt: machine ID/name, source revisions, installed Skills,
  instruction hash/link checks and any pending authentication or other exceptions.
- Remove only setup-owned temporary files/shell sessions. No Connector or active
  agent restart is needed just to synchronize Skills or instruction files.
  Existing agents may cache instructions; use a fresh session when reliable reload
  is needed, or an explicitly requested supported reload.

Do not call the new-machine setup complete while a required item is missing.
New machines join the same ongoing fleet synchronization policy in `CLAUDE.md`:
future Skill/global-instruction changes must reach every registered machine and
all three agent roots. List offline or unreachable machines and finish their
pending synchronization when they are next available; do not claim an automatic
background retry service exists unless one has actually been implemented.
