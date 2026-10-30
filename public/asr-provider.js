export const ASR_PREFERENCE_KEY = "tmux-mobile.asr-provider.v1";
export const ASR_OPTIONS = [
  { value: "auto", label: "Automatic", description: "Use Doubao first; switch to WeChat if it fails." },
  { value: "doubao", label: "Doubao", description: "Use Doubao only. No automatic switch." },
  { value: "wetype", label: "WeChat", description: "Use WeChat only. No automatic switch." },
];
export const normalizeAsrMode = value => ASR_OPTIONS.some(option => option.value === value) ? value : "auto";
export const asrProviderName = value => value === "wetype" ? "WeChat" : value === "doubao" ? "Doubao" : "";
export function asrStatus(stage, provider) {
  const name = asrProviderName(provider), suffix = name ? ` · ${name}` : "";
  if (stage === "finishing") return `Microphone off${suffix} · Finishing transcription…`;
  if (stage === "done") return `Voice added${suffix}`;
  return `Listening${suffix} · Stop to finish, or Send`;
}
export function readAsrMode() {
  try { return normalizeAsrMode(globalThis.localStorage?.getItem(ASR_PREFERENCE_KEY)); }
  catch { return "auto"; }
}
export function saveAsrMode(value) {
  if (normalizeAsrMode(value) !== value) throw new Error("Invalid speech recognition service");
  globalThis.localStorage.setItem(ASR_PREFERENCE_KEY, value);
}
// Async storage for native clients. A late initial read cannot undo a user's save.
export function createAsrPreference(storage) {
  let value = "auto", revision = 0, loading, writes = Promise.resolve();
  const listeners = new Set();
  const update = next => { value = next; listeners.forEach(listener => listener()); };
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => value,
    load() {
      if (!loading) {
        const initialRevision = revision;
        loading = storage.getItem(ASR_PREFERENCE_KEY).then(saved => {
          if (initialRevision === revision) update(normalizeAsrMode(saved));
        }).catch(error => { loading = undefined; throw error; });
      }
      return loading;
    },
    setMode(next) {
      if (normalizeAsrMode(next) !== next) return Promise.reject(new Error("Invalid speech recognition service"));
      const operation = writes.catch(() => {}).then(async () => {
        await storage.setItem(ASR_PREFERENCE_KEY, next);
        revision++;
        update(next);
        loading = Promise.resolve();
      });
      writes = operation;
      return operation;
    },
  };
}
