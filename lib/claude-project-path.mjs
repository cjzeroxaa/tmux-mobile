// Claude Code's project-storage key (verified against the installed 2.1.316
// runtime). Keep transcript and session-index lookup on the same encoding.
export function claudeProjectKey(cwd) {
  const value = String(cwd || "");
  const encoded = value.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= 200) return encoded;
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}
