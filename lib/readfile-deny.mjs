// Configurable denylist for the smart-viewer file read. readfile has no
// directory confinement — the boundary is OS permissions — but some files the
// agent's user *can* read should still never be served through the web app
// (SSH/cloud keys, .env, shell history, etc.). This denylist blocks them.
//
// Configure with TMUX_MOBILE_READFILE_DENY: a ':'-separated list of glob
// patterns. A pattern matches if it matches the file's absolute (realpath'd)
// path OR just its basename. Set it to an empty string to disable the default
// list entirely; set TMUX_MOBILE_READFILE_DENY_EXTRA to append to the defaults.
//
// Globs support: `*` (any run except `/`), `**` (any run incl `/`), `?` (one
// non-`/` char). Everything else is literal. Matching is case-sensitive.

import os from "node:os";
import path from "node:path";

// Sensible defaults: credentials and secrets that should never leave the box via
// a casual file-view click. Kept conservative — these are clear secrets, not
// general source files.
export const DEFAULT_DENY = [
  "**/.ssh/**",
  "**/.aws/**",
  "**/.gnupg/**",
  "**/.kube/**",
  "**/.config/gcloud/**",
  "**/.docker/config.json",
  "**/.netrc",
  "**/.npmrc",
  "**/.pypirc",
  "**/.git-credentials",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/*_history", // .bash_history, .zsh_history, etc.
  "/etc/shadow",
  "/etc/sudoers",
  "/etc/sudoers.d/**",
];

function splitPatterns(value) {
  return String(value || "")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Resolve the active patterns from the environment. Precedence:
//   - TMUX_MOBILE_READFILE_DENY set (even to ""): use it verbatim (replaces
//     defaults; "" => no denylist).
//   - otherwise: DEFAULT_DENY, plus TMUX_MOBILE_READFILE_DENY_EXTRA if present.
export function denyPatterns(env = process.env) {
  const base =
    env.TMUX_MOBILE_READFILE_DENY !== undefined
      ? splitPatterns(env.TMUX_MOBILE_READFILE_DENY)
      : DEFAULT_DENY.slice();
  const extra = splitPatterns(env.TMUX_MOBILE_READFILE_DENY_EXTRA);
  return [...base, ...extra];
}

// Convert a glob to an anchored RegExp. `**` -> any chars; `*` -> any non-slash
// run; `?` -> one non-slash char; everything else escaped literally.
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

// True if `absPath` is denied by any active pattern. A pattern is tested against
// both the full absolute path and the basename, so `*.pem` (basename-style) and
// `**/.ssh/**` (path-style) both work.
export function isDenied(absPath, patterns = denyPatterns()) {
  const full = String(absPath);
  const base = path.basename(full);
  for (const pattern of patterns) {
    const re = globToRegExp(pattern);
    if (re.test(full) || re.test(base)) return true;
  }
  return false;
}

// Convenience for tests / callers that want the home dir expanded the same way
// readfile does (not used by readfile itself, which passes an already-resolved
// absolute path).
export function expandHome(p) {
  const s = String(p);
  if (s === "~" || s.startsWith("~/")) return path.join(os.homedir(), s.slice(1));
  return s;
}
