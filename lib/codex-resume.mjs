import { open, stat } from "node:fs/promises";
import { defaultTranscriptRoots, discoverTranscriptFiles } from "./transcript-discovery.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const valueOptions = new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-s", "--sandbox", "-a", "--ask-for-approval", "-C", "--cd", "--add-dir", "--enable", "--disable"]);
const flags = new Set(["--dangerously-bypass-approvals-and-sandbox", "--yolo", "--full-auto", "--no-alt-screen", "--search", "--all"]);
const paths = new Map();

export function codexResumeSessionId(command) {
  // ps prints argv, not a shell script. Respect quoted prompt/config values so
  // text containing "resume UUID" cannot become a session identity.
  const args = String(command || "").match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const executable = args.findIndex(arg => /(?:^|\/)codex(?:\.(?:c|m)?js|\/[^\s]*\/cli\.js)?$/.test(arg));
  if (executable < 0) return "";
  let resumed = false;
  for (let i = executable + 1; i < args.length; i++) {
    const arg = args[i];
    if (valueOptions.has(arg)) { i++; continue; }
    if (flags.has(arg) || [...valueOptions].some(option => arg.startsWith(`${option}=`))) continue;
    if (!resumed) {
      if (arg !== "resume") return "";
      resumed = true;
    } else {
      return UUID.test(arg) ? arg.toLowerCase() : "";
    }
  }
  return "";
}

export async function findCodexResumeTranscript(command, { roots = defaultTranscriptRoots() } = {}) {
  const id = codexResumeSessionId(command);
  if (!id) return "";
  const codexRoots = roots.filter(root => root.kind === "codex");
  const key = JSON.stringify([codexRoots, id]);
  let candidates = paths.get(key);
  if (!candidates || (candidates.files.length !== 1 && Date.now() - candidates.checkedAt > 8_000)) {
    const files = await discoverTranscriptFiles({ roots: codexRoots });
    candidates = { checkedAt: Date.now(), files: files.filter(f => f.agentSessionId.toLowerCase() === id) };
    paths.set(key, candidates);
    while (paths.size > 64) paths.delete(paths.keys().next().value);
  }
  // Duplicated or conflicting files are ambiguous. Never pick by mtime/cwd.
  if (candidates.files.length !== 1) return "";
  const filename = candidates.files[0].transcriptPath;
  let file;
  try {
    file = await open(filename, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const header = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0]);
    if (header.type !== "session_meta" || String(header.payload?.id || "").toLowerCase() !== id) return "";
    if (typeof header.payload?.source === "object" && header.payload.source?.subagent) return "";
    return (await stat(filename)).isFile() ? filename : "";
  } catch {
    paths.delete(key);
    return "";
  } finally {
    await file?.close().catch(() => {});
  }
}
