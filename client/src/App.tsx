import {
  Expand,
  Keyboard,
  Loader2,
  Mic,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Skull,
  Square,
  Terminal,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Session = {
  id: string;
  name: string;
  windows: number;
  attached: boolean;
};

type WindowItem = {
  id: string;
  sessionId: string;
  sessionName: string;
  index: number;
  name: string;
  active: boolean;
  panes: number;
  activeCommand?: string;
};

type Pane = {
  id: string;
  index: number;
  active: boolean;
  command: string;
  cwd: string;
  width: number;
  height: number;
  title: string;
};

type DirectoryEntry = {
  name: string;
  path: string;
  hidden?: boolean;
};

type DirectoryState = {
  cwd: string;
  parent: string;
  entries: DirectoryEntry[];
  loading: boolean;
  error: string;
};

type CaptureResponse = {
  text: string;
};

type WindowSummary = {
  windowId: string;
  summary: string;
};

type VoiceState = "idle" | "recording" | "transcribing" | "sending";

const lineOptions = [50, 120, 250, 500, 1000];
const keyActions = [
  { label: "Enter", key: "Enter" },
  { label: "q", key: "q" },
  { label: "Esc", key: "Escape" },
  { label: "Ctrl-C", key: "C-c", danger: true },
];

async function api<T>(path: string, options: RequestInit & { body?: unknown } = {}) {
  const headers = new Headers(options.headers);
  let body = options.body as BodyInit | undefined;
  if (
    body !== undefined &&
    !(body instanceof Blob) &&
    !(body instanceof FormData) &&
    typeof body !== "string"
  ) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(body);
  }
  if (typeof body === "string" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { cache: "no-store", ...options, headers, body });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`);
  return json as T;
}

function b64ToBlob(base64: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

function shellQuote(value: string) {
  return `'${String(value || "").replaceAll("'", "'\\''")}'`;
}

function pathLabel(value: string) {
  const trimmed = String(value || "").replace(/\/+$/, "");
  if (!trimmed) return value || "/";
  return trimmed.split("/").pop() || trimmed;
}

function BrandClaude(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

function BrandOpenAI(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

function BrandGemini(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
    </svg>
  );
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [windows, setWindows] = useState<WindowItem[]>([]);
  const [panes, setPanes] = useState<Pane[]>([]);
  const [sessionId, setSessionId] = useState(localStorage.getItem("sessionId") || "");
  const [windowId, setWindowId] = useState(localStorage.getItem("windowId") || "");
  const [paneId, setPaneId] = useState(localStorage.getItem("paneId") || "");
  const [lines, setLines] = useState(Number(localStorage.getItem("lines") || 120));
  const [auto, setAuto] = useState(localStorage.getItem("auto") !== "false");
  const [snapshot, setSnapshot] = useState("Select a window.");
  const [targetOpen, setTargetOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [busy, setBusy] = useState(false);
  const [directory, setDirectory] = useState<DirectoryState>({
    cwd: "",
    parent: "",
    entries: [],
    loading: false,
    error: "",
  });
  const [textMode, setTextMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [reading, setReading] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const snapshotRef = useRef<HTMLPreElement | null>(null);

  const selectedSession = useMemo(
    () => sessions.find((item) => item.id === sessionId),
    [sessionId, sessions],
  );
  const selectedWindow = useMemo(
    () => windows.find((item) => item.id === windowId),
    [windowId, windows],
  );
  const selectedPane = useMemo(
    () => panes.find((item) => item.id === paneId),
    [paneId, panes],
  );

  const loadSessions = useCallback(async () => {
    const next = await api<Session[]>("/api/sessions");
    setSessions(next);
    const valid = next.some((item) => item.id === sessionId);
    const chosen = valid ? sessionId : next[0]?.id || "";
    if (chosen !== sessionId) setSessionId(chosen);
    return chosen;
  }, [sessionId]);

  const loadWindows = useCallback(
    async (targetSessionId = sessionId) => {
      if (!targetSessionId) {
        setWindows([]);
        setWindowId("");
        return "";
      }
      const next = await api<WindowItem[]>(
        `/api/windows?sessionId=${encodeURIComponent(targetSessionId)}`,
      );
      setWindows(next);
      const valid = next.some((item) => item.id === windowId);
      const active = next.find((item) => item.active);
      const chosen = valid ? windowId : active?.id || next[0]?.id || "";
      if (chosen !== windowId) setWindowId(chosen);
      return chosen;
    },
    [sessionId, windowId],
  );

  const loadPanes = useCallback(
    async (targetWindowId = windowId) => {
      if (!targetWindowId) {
        setPanes([]);
        setPaneId("");
        return "";
      }
      const next = await api<Pane[]>(
        `/api/panes?windowId=${encodeURIComponent(targetWindowId)}`,
      );
      setPanes(next);
      const valid = next.some((item) => item.id === paneId);
      const active = next.find((item) => item.active);
      const chosen = valid ? paneId : active?.id || next[0]?.id || "";
      if (chosen !== paneId) setPaneId(chosen);
      return chosen;
    },
    [paneId, windowId],
  );

  const loadDirectory = useCallback(
    async (targetPaneId = paneId, panesSnapshot = panes) => {
      const pane = panesSnapshot.find((item) => item.id === targetPaneId);
      if (!targetPaneId) {
        setDirectory({ cwd: "", parent: "", entries: [], loading: false, error: "" });
        return;
      }
      setDirectory((current) => ({
        ...current,
        cwd: pane?.cwd || current.cwd,
        loading: true,
        error: "",
      }));
      try {
        const data = await api<Omit<DirectoryState, "loading" | "error">>(
          `/api/directories?paneId=${encodeURIComponent(targetPaneId)}`,
        );
        setDirectory({
          cwd: data.cwd || pane?.cwd || "",
          parent: data.parent || "",
          entries: Array.isArray(data.entries) ? data.entries : [],
          loading: false,
          error: "",
        });
      } catch (error) {
        setDirectory((current) => ({
          ...current,
          cwd: pane?.cwd || current.cwd,
          entries: [],
          loading: false,
          error: error instanceof Error ? error.message : "Directory unavailable",
        }));
      }
    },
    [paneId, panes],
  );

  const capture = useCallback(
    async (targetPaneId = paneId) => {
      if (!targetPaneId) {
        setSnapshot("Select a window.");
        return;
      }
      const data = await api<CaptureResponse>(
        `/api/capture?paneId=${encodeURIComponent(targetPaneId)}&mode=tail&lines=${lines}`,
      );
      setSnapshot(data.text || "[no visible output]");
      requestAnimationFrame(() => {
        const node = snapshotRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      });
    },
    [lines, paneId],
  );

  const refreshAll = useCallback(async () => {
    setBusy(true);
    try {
      const nextSessionId = await loadSessions();
      const nextWindowId = await loadWindows(nextSessionId);
      const nextPaneId = await loadPanes(nextWindowId);
      await Promise.all([capture(nextPaneId), loadDirectory(nextPaneId)]);
      setStatus("Ready");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Refresh failed");
    } finally {
      setBusy(false);
    }
  }, [capture, loadDirectory, loadPanes, loadSessions, loadWindows]);

  useEffect(() => {
    refreshAll();
  }, []);

  useEffect(() => {
    localStorage.setItem("sessionId", sessionId);
  }, [sessionId]);
  useEffect(() => {
    localStorage.setItem("windowId", windowId);
  }, [windowId]);
  useEffect(() => {
    localStorage.setItem("paneId", paneId);
  }, [paneId]);
  useEffect(() => {
    localStorage.setItem("lines", String(lines));
  }, [lines]);
  useEffect(() => {
    localStorage.setItem("auto", String(auto));
    if (!auto) return;
    const timer = window.setInterval(() => {
      refreshAll();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [auto, refreshAll]);

  async function chooseSession(nextSessionId: string) {
    setSessionId(nextSessionId);
    setWindowId("");
    setPaneId("");
    const nextWindowId = await loadWindows(nextSessionId);
    const nextPaneId = await loadPanes(nextWindowId);
    await Promise.all([capture(nextPaneId), loadDirectory(nextPaneId)]);
  }

  async function chooseWindow(nextWindowId: string) {
    setWindowId(nextWindowId);
    setPaneId("");
    const nextPaneId = await loadPanes(nextWindowId);
    await Promise.all([capture(nextPaneId), loadDirectory(nextPaneId)]);
    setTargetOpen(false);
  }

  async function sendText(text: string, enter = true) {
    if (!paneId || !text) return;
    await api("/api/send", {
      method: "POST",
      body: { paneId, text, enter, submitNudge: enter },
    });
    window.setTimeout(() => {
      capture();
      loadDirectory();
    }, 400);
  }

  async function sendKey(key: string) {
    if (!paneId) return;
    await api("/api/key", { method: "POST", body: { paneId, key } });
    window.setTimeout(() => capture(), 250);
  }

  async function createSession() {
    const name = window.prompt("Session name", `mobile-${Date.now().toString().slice(-5)}`);
    if (name === null) return;
    await api<Session>("/api/sessions", { method: "POST", body: { name } });
    await refreshAll();
  }

  async function renameSession() {
    if (!selectedSession) return;
    const name = window.prompt("Rename session", selectedSession.name);
    if (!name) return;
    await api("/api/sessions", {
      method: "PATCH",
      body: { sessionId: selectedSession.id, name },
    });
    await refreshAll();
  }

  async function createWindow() {
    if (!sessionId) return;
    const win = await api<WindowItem>("/api/windows", {
      method: "POST",
      body: { sessionId },
    });
    await loadWindows(sessionId);
    if (win.id) await chooseWindow(win.id);
  }

  async function killWindow() {
    if (!selectedWindow || windows.length <= 1) return;
    if (!window.confirm(`Kill ${selectedWindow.index}: ${selectedWindow.name}?`)) return;
    await api("/api/windows", {
      method: "DELETE",
      body: { windowId: selectedWindow.id },
    });
    setWindowId("");
    setPaneId("");
    await refreshAll();
  }

  async function changeDirectory(path: string) {
    if (!path) return;
    setStatus(`cd ${pathLabel(path)}`);
    await sendText(`cd ${shellQuote(path)}`, true);
  }

  async function loadSummaries() {
    if (!sessionId) return;
    try {
      const data = await api<{ summaries: WindowSummary[] }>(
        `/api/window-summaries?sessionId=${encodeURIComponent(sessionId)}&lines=20&refresh=1`,
      );
      setSummaries(
        Object.fromEntries((data.summaries || []).map((item) => [item.windowId, item.summary])),
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Summary failed");
    }
  }

  async function startVoice() {
    if (voiceState !== "idle") return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    voiceChunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) voiceChunksRef.current.push(event.data);
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(voiceChunksRef.current, { type: recorder.mimeType || "audio/webm" });
      setVoiceState("transcribing");
      try {
        const data = await api<{ text: string }>("/api/transcribe", {
          method: "POST",
          headers: { "content-type": blob.type || "audio/webm" },
          body: blob,
        });
        setVoiceState("sending");
        await sendText(data.text, true);
        setStatus(data.text);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Voice failed");
      } finally {
        setVoiceState("idle");
      }
    };
    mediaRecorderRef.current = recorder;
    recorder.start();
    setVoiceState("recording");
  }

  function stopVoice() {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
  }

  async function toggleRead() {
    if (reading) {
      audioRef.current?.pause();
      audioRef.current = null;
      setReading(false);
      return;
    }
    const targetPane = paneId;
    if (!targetPane && !windowId) return;
    setReading(true);
    try {
      const data = await api<{
        audioBase64: string;
        mimeType: string;
        summary: string;
      }>("/api/window-audio-summary", {
        method: "POST",
        body: { windowId, lines: Math.min(lines, 100) },
      });
      const blob = b64ToBlob(data.audioBase64, data.mimeType || "audio/mpeg");
      const audio = new Audio(URL.createObjectURL(blob));
      audioRef.current = audio;
      audio.onended = () => setReading(false);
      await audio.play();
      setStatus(data.summary);
    } catch (error) {
      setReading(false);
      setStatus(error instanceof Error ? error.message : "Read failed");
    }
  }

  const windowStatus = selectedWindow
    ? selectedWindow.active
      ? "Active"
      : "Background"
    : "Idle";

  return (
    <main
      className={cn(
        "mx-auto grid h-dvh w-full max-w-xl grid-rows-[auto_minmax(260px,1fr)_auto] gap-2 overflow-hidden bg-background p-2",
        fullscreen && "max-w-none p-0",
      )}
    >
      {!fullscreen && (
        <header className="flex gap-2">
          <Button
            variant="outline"
            className="h-14 min-w-0 flex-1 justify-start rounded-xl px-3"
            onClick={() => setTargetOpen(true)}
          >
            <div className="min-w-0 text-left">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Attached window
              </div>
              <div className="truncate text-base">
                {selectedWindow
                  ? `${selectedSession?.name || ""} / ${selectedWindow.index}:${selectedWindow.name}`
                  : "No window selected"}
              </div>
            </div>
          </Button>
          <Button variant="outline" size="icon" className="h-14 w-12 rounded-xl" onClick={refreshAll}>
            {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </header>
      )}

      <Card className={cn("grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden", fullscreen && "rounded-none border-0")}>
        <div className="flex flex-wrap items-center gap-2 border-b p-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>Lines</span>
            <Select value={String(lines)} onValueChange={(value) => setLines(Number(value))}>
              <SelectTrigger className="h-9 w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {lineOptions.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={auto} onCheckedChange={setAuto} />
            Auto
          </label>
          <Badge variant={selectedWindow?.active ? "default" : "secondary"}>{windowStatus}</Badge>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => setFullscreen((value) => !value)}
          >
            <Expand />
          </Button>
        </div>
        <pre
          ref={snapshotRef}
          className="terminal-output min-h-0 overflow-auto bg-zinc-950 p-3 text-[11px] leading-relaxed text-zinc-100"
        >
          {snapshot}
        </pre>
      </Card>

      {!fullscreen && (
        <Card className="max-h-[43dvh] min-h-0 w-full overflow-y-auto overflow-x-hidden">
          <CardContent className="grid min-w-0 gap-2 p-2">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_44px] gap-2">
              <Button
                variant={voiceState === "recording" ? "destructive" : "outline"}
                className="h-12 min-w-0 rounded-full"
                onClick={voiceState === "recording" ? stopVoice : startVoice}
                disabled={voiceState === "transcribing" || voiceState === "sending"}
              >
                {voiceState === "idle" ? (
                  <Mic />
                ) : voiceState === "recording" ? (
                  <Square />
                ) : (
                  <Loader2 className="animate-spin" />
                )}
                <span className="sr-only">{voiceState}</span>
              </Button>
              <Button variant="outline" size="icon" className="h-12 w-11" onClick={() => setTextMode((value) => !value)}>
                <Keyboard />
              </Button>
            </div>

            {textMode && (
              <form
                className="grid grid-cols-[minmax(0,1fr)_48px] gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  sendText(draft, true);
                  setDraft("");
                  setTextMode(false);
                }}
              >
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Paste text"
                  className="max-h-48 min-h-24 resize-y"
                />
                <Button type="submit" size="icon" className="h-full min-h-24">
                  <Send />
                </Button>
              </form>
            )}

            <div className="text-xs text-muted-foreground">{status}</div>

            <div className="grid w-full min-w-0 grid-cols-5 gap-1.5 overflow-hidden">
              {keyActions.map((action) => (
                <Button
                  key={action.key}
                  variant={action.danger ? "destructive" : "outline"}
                  className="h-10 min-w-0 px-1 text-[11px] font-semibold leading-none"
                  title={action.label}
                  onClick={() => sendKey(action.key)}
                >
                  {action.label}
                </Button>
              ))}
              <Button variant="outline" className="h-10 min-w-0 p-0 text-teal-700" title="Claude Code" onClick={() => sendText("claude", true)}>
                <BrandClaude className="h-5 w-5" />
                <span className="sr-only">Claude Code</span>
              </Button>
              <Button variant="outline" className="h-10 min-w-0 p-0" title="Codex" onClick={() => sendText("codex", true)}>
                <BrandOpenAI className="h-5 w-5" />
                <span className="sr-only">Codex</span>
              </Button>
              <Button variant="outline" className="h-10 min-w-0 p-0 text-blue-700" title="AGR" onClick={() => sendText("agr", true)}>
                <BrandGemini className="h-5 w-5" />
                <span className="sr-only">AGR</span>
              </Button>
              <Button variant="outline" className="h-10 min-w-0 px-1 text-[11px] font-semibold leading-none" title="Insert /goal" onClick={() => sendText("/goal ", false)}>
                Goal
              </Button>
              <Button variant="outline" className="h-10 min-w-0 px-1 text-[11px] font-semibold leading-none" title="Run /clear" onClick={() => sendText("/clear", true)}>
                Clear
              </Button>
              <Button
                variant={reading ? "destructive" : "outline"}
                className="h-10 min-w-0 px-1 text-[11px] font-semibold leading-none"
                title={reading ? "Stop reading" : "Read current window"}
                onClick={toggleRead}
              >
                {reading ? "Stop" : "Read"}
              </Button>
            </div>

            <div className="min-w-0 rounded-lg border p-2">
              <div className="mb-2 flex items-center gap-2">
                <Terminal className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0 flex-1 truncate font-mono text-xs">
                  {selectedPane?.cwd || directory.cwd || "No directory"}
                </div>
                {directory.loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              </div>
              <div className="dir-scroll -mx-1 overflow-x-auto overflow-y-hidden px-1 pb-1" aria-label="Directory folders">
                <div className="flex w-max min-w-full gap-1.5">
                  {directory.parent && directory.parent !== directory.cwd && (
                    <Button variant="secondary" size="sm" className="shrink-0" onClick={() => changeDirectory(directory.parent)}>
                      ..
                    </Button>
                  )}
                  {directory.entries.map((entry) => (
                    <Button
                      key={entry.path}
                      variant="outline"
                      size="sm"
                      className="max-w-36 shrink-0 truncate"
                      onClick={() => changeDirectory(entry.path)}
                    >
                      {entry.name}
                    </Button>
                  ))}
                  {!directory.loading && directory.entries.length === 0 && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {directory.error ? "Directory unavailable" : "No child directories"}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={targetOpen} onOpenChange={setTargetOpen}>
        <DialogContent className="top-auto bottom-0 max-h-[92dvh] translate-y-0 rounded-b-none sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2 sm:rounded-xl">
          <DialogHeader>
            <DialogTitle>Switch Target</DialogTitle>
            <DialogDescription>Select a tmux session and window.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" onClick={refreshAll}>
                <RefreshCw />
              </Button>
              <Button variant="outline" size="icon" onClick={loadSummaries}>
                <Zap />
              </Button>
              <div className="ml-auto text-xs text-muted-foreground">{status}</div>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
              <Select value={sessionId || undefined} onValueChange={chooseSession}>
                <SelectTrigger>
                  <SelectValue placeholder="Session" />
                </SelectTrigger>
                <SelectContent>
                  {sessions.map((session) => (
                    <SelectItem key={session.id} value={session.id}>
                      {session.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" onClick={createSession}>
                <Plus />
              </Button>
              <Button variant="outline" size="icon" onClick={renameSession}>
                <Pencil />
              </Button>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={createWindow}>
                <Plus className="h-4 w-4" />
                Window
              </Button>
              <Button variant="destructive" size="sm" onClick={killWindow} disabled={windows.length <= 1}>
                <Skull className="h-4 w-4" />
                Kill
              </Button>
            </div>
            <ScrollArea className="h-[48dvh] rounded-md border">
              <div className="grid gap-2 p-2">
                {windows.map((win) => (
                  <button
                    key={win.id}
                    className={cn(
                      "rounded-lg border p-3 text-left transition-colors hover:bg-accent",
                      win.id === windowId && "border-primary bg-accent",
                    )}
                    onClick={() => chooseWindow(win.id)}
                  >
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1 truncate font-medium">
                        {win.index}: {win.name}
                      </div>
                      {win.active && <Badge>Active</Badge>}
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {summaries[win.id] || win.activeCommand || `${win.panes} panes`}
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
