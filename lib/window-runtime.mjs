import path from "node:path";
import { isScrollbackMode } from "./pane-mode.mjs";

// WindowRuntime is the product-level seam above tmux/RMUX/etc. The service
// should speak in windows; tmux sessions and panes stay adapter metadata.

export const tmuxFormats = {
  sessions:
    "#{session_id}\t#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created_string}",
  // NOTE: @tm_annotation is free text and may contain tabs. It must stay last,
  // so windowFromTmuxRow takes everything from its index onward.
  windows:
    "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{window_flags}\t#{pane_current_command}\t#{pane_tty}\t#{pane_current_path}\t#{@tm_annotation}",
  panes:
    "#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}\t#{pane_mode}\t#{pane_pid}\t#{pane_title}",
  paneInfo:
    "#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}\t#{pane_active}",
};

const TREE_SESSION_FIELDS =
  "#{session_id}\t#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created_string}\t";

export function createTmuxWindowRuntime(backend) {
  return new TmuxWindowRuntime(backend);
}

export function isNoMuxServerError(error) {
  return /no server running|failed to connect to server|error connecting to .*\/tmux-/i.test(
    error?.message || "",
  );
}

export function requireRuntimeId(value, type) {
  const patterns = {
    session: /^\$\d+$/,
    window: /^@\d+$/,
    pane: /^%\d+$/,
    surface: /^%\d+$/,
  };
  if (!patterns[type]?.test(value || "")) {
    const error = new Error(`Invalid ${type} id`);
    error.status = 400;
    throw error;
  }
  return value;
}

function requireName(value, label) {
  const name = String(value || "").trim();
  if (!name) {
    const error = new Error(`${label} is required`);
    error.status = 400;
    throw error;
  }
  if (name.length > 80 || /[:\t\r\n]/.test(name)) {
    const error = new Error(`${label} cannot include colon, tabs, or newlines`);
    error.status = 400;
    throw error;
  }
  return name;
}

function rows(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

function requireFieldCount(row, minFields, label) {
  if (row.length >= minFields) return;
  const error = new Error(
    `Malformed tmux ${label} row: expected at least ${minFields} tab-separated fields, got ${row.length}`,
  );
  error.status = 500;
  throw error;
}

function requireNumericField(value, label) {
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const error = new Error(`Malformed tmux row: ${label} must be numeric`);
  error.status = 500;
  throw error;
}

export function sessionFromTmuxRow(row) {
  requireFieldCount(row, 5, "session");
  const [id, name, windows, attached, created] = row;
  requireRuntimeId(id, "session");
  return {
    id,
    name,
    windows: requireNumericField(windows || 0, "session_windows"),
    attached: attached === "1",
    created,
  };
}

export function windowFromTmuxRow(fields) {
  requireFieldCount(fields, 10, "window");
  const [id, index, name, active, panes, flags, activeCommand, tty, cwd] = fields;
  requireRuntimeId(id, "window");
  const annotation = fields.slice(9).join("\t");
  return {
    id,
    index: requireNumericField(index, "window_index"),
    name,
    active: active === "1",
    panes: requireNumericField(panes || 0, "window_panes"),
    flags,
    activeCommand,
    tty: tty || "",
    cwd: cwd || "",
    annotation: annotation || "",
  };
}

function paneFromTmuxRow(row) {
  const [id, index, active, command, cwd, width, height, mode, pid, ...titleParts] = row;
  requireRuntimeId(id, "pane");
  return {
    id,
    surfaceId: id,
    kind: "tmux-pane",
    index: Number(index),
    active: active === "1",
    command,
    cwd,
    width: Number(width || 0),
    height: Number(height || 0),
    pid: Number(pid || 0) || null,
    inCopyMode: isScrollbackMode(mode),
    title: titleParts.join("\t"),
  };
}

function stripTmuxQuotedCommand(raw) {
  const text = String(raw || "").trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

const DUP_SHELLS = new Set(["bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh", "csh"]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TmuxWindowRuntime {
  constructor(backend) {
    this.kind = "tmux";
    this.backend = backend;
  }

  capabilities() {
    return {
      model: "window-first",
      sessionsAsMetadata: true,
      surfacesAreCompatibilityOnly: true,
      runtime: this.kind,
    };
  }

  tmux(args, options = {}) {
    return this.backend.tmux(args, options);
  }

  async listSessions() {
    try {
      const stdout = await this.tmux(["list-sessions", "-F", tmuxFormats.sessions]);
      return rows(stdout).map(sessionFromTmuxRow);
    } catch (error) {
      if (isNoMuxServerError(error)) return [];
      throw error;
    }
  }

  async createSession({ name } = {}) {
    const sessionName = requireName(name, "Session name");
    const stdout = await this.tmux([
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-P",
      "-F",
      tmuxFormats.sessions,
    ]);
    const [row] = rows(stdout);
    if (!row) {
      const error = new Error("tmux did not return the new session");
      error.status = 500;
      throw error;
    }
    return sessionFromTmuxRow(row);
  }

  async renameSession({ sessionId, name } = {}) {
    requireRuntimeId(sessionId, "session");
    const sessionName = requireName(name, "Session name");
    await this.tmux(["rename-session", "-t", sessionId, sessionName]);
    return this.getSession({ sessionId, what: "renamed" });
  }

  async getSession({ sessionId, what = "selected" } = {}) {
    requireRuntimeId(sessionId, "session");
    const stdout = await this.tmux([
      "display-message",
      "-p",
      "-t",
      sessionId,
      tmuxFormats.sessions,
    ]);
    const [row] = rows(stdout);
    if (!row) {
      const error = new Error(`tmux did not return the ${what} session`);
      error.status = 500;
      throw error;
    }
    return sessionFromTmuxRow(row);
  }

  async listWindows({ sessionId } = {}) {
    requireRuntimeId(sessionId, "session");
    const stdout = await this.tmux([
      "list-windows",
      "-t",
      sessionId,
      "-F",
      tmuxFormats.windows,
    ]);
    return rows(stdout).map(windowFromTmuxRow);
  }

  async listTree() {
    let windowRows = [];
    try {
      const stdout = await this.tmux([
        "list-windows",
        "-a",
        "-F",
        TREE_SESSION_FIELDS + tmuxFormats.windows,
      ]);
      windowRows = rows(stdout);
    } catch (error) {
      if (isNoMuxServerError(error)) return { sessions: [], windows: [] };
      throw error;
    }
    const sessionsById = new Map();
    const windows = [];
    for (const row of windowRows) {
      const sessionFields = row.slice(0, 5);
      const windowFields = row.slice(5);
      const [sessionId] = sessionFields;
      if (!sessionsById.has(sessionId)) {
        sessionsById.set(sessionId, sessionFromTmuxRow(sessionFields));
      }
      windows.push({ ...windowFromTmuxRow(windowFields), sessionId });
    }
    return {
      sessions: [...sessionsById.values()],
      windows,
    };
  }

  async createWindow({
    sessionId = "",
    afterWindowId = "",
    cwd = "",
    name = "",
    command = "",
  } = {}) {
    const target = afterWindowId
      ? requireRuntimeId(afterWindowId, "window")
      : requireRuntimeId(sessionId, "session");
    const args = ["new-window"];
    if (afterWindowId) args.push("-a");
    args.push("-P", "-F", tmuxFormats.windows, "-t", target);
    if (cwd) args.push("-c", cwd);
    if (name) args.push("-n", String(name).trim());
    if (command) args.push(String(command).trim());
    const stdout = await this.tmux(args);
    const [row] = rows(stdout);
    if (!row) {
      const error = new Error("tmux did not return the new window");
      error.status = 500;
      throw error;
    }
    return windowFromTmuxRow(row);
  }

  async renameWindow({ windowId, name } = {}) {
    requireRuntimeId(windowId, "window");
    const windowName = requireName(name, "Window name");
    await this.tmux(["rename-window", "-t", windowId, windowName]);
    return { ok: true };
  }

  async getWindowInfo({ windowId } = {}) {
    requireRuntimeId(windowId, "window");
    const stdout = await this.tmux([
      "display-message",
      "-p",
      "-t",
      windowId,
      "#{session_id}\t#{session_name}\t#{window_index}\t#{window_name}",
    ]);
    const [sessionId = "", sessionName = "", windowIndex = "", windowName = ""] =
      stdout.trimEnd().split("\t");
    return {
      windowId,
      sessionId,
      sessionName,
      windowIndex: Number(windowIndex),
      windowName,
    };
  }

  async getDuplicateDefaults({ windowId } = {}) {
    requireRuntimeId(windowId, "window");
    const info = await this.getWindowInfo({ windowId });
    const stdout = await this.tmux([
      "display-message",
      "-p",
      "-t",
      windowId,
      "#{pane_current_path}\t#{pane_current_command}\t#{pane_start_command}",
    ]);
    const [cwd = "", currentCommand = "", rawStartCommand = ""] = stdout
      .trimEnd()
      .split("\t");
    const startCommand = stripTmuxQuotedCommand(rawStartCommand);
    const command =
      startCommand ||
      (currentCommand && !DUP_SHELLS.has(currentCommand) ? currentCommand : "");
    return {
      sessionId: info.sessionId,
      name: info.windowName || "",
      command,
      cwd,
    };
  }

  async duplicateWindow({ windowId, name, command } = {}) {
    requireRuntimeId(windowId, "window");
    const defaults = await this.getDuplicateDefaults({ windowId });
    const finalName = name !== undefined ? String(name).trim() : defaults.name;
    const finalCommand =
      command !== undefined ? String(command).trim() : defaults.command;
    const window = await this.createWindow({
      sessionId: defaults.sessionId,
      cwd: defaults.cwd,
      name: finalName,
      command: finalCommand,
    });
    return { ...window, duplicatedFrom: windowId, command: finalCommand || "" };
  }

  async setWindowNote({ windowId, note, maxBytes = 64 * 1024 } = {}) {
    requireRuntimeId(windowId, "window");
    const text = String(note ?? "");
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      const error = new Error("Annotation is too large");
      error.status = 413;
      throw error;
    }
    if (text.trim() === "") {
      await this.tmux(["set-option", "-w", "-t", windowId, "-u", "@tm_annotation"]);
    } else {
      await this.tmux(["set-option", "-w", "-t", windowId, "@tm_annotation", text]);
    }
    const stdout = await this.tmux([
      "display-message",
      "-p",
      "-t",
      windowId,
      tmuxFormats.windows,
    ]);
    const [row] = rows(stdout);
    if (!row) {
      const error = new Error("tmux did not return the annotated window");
      error.status = 500;
      throw error;
    }
    return windowFromTmuxRow(row);
  }

  async closeWindow({ windowId } = {}) {
    requireRuntimeId(windowId, "window");
    const killed = await this.getWindowInfo({ windowId });
    const windows = await this.listWindows({ sessionId: killed.sessionId });
    const killedSession = windows.length <= 1;
    await this.tmux(["kill-window", "-t", windowId]);
    return { ok: true, killed, killedSession };
  }

  async listWindowSurfaces({ windowId } = {}) {
    requireRuntimeId(windowId, "window");
    const stdout = await this.tmux([
      "list-panes",
      "-t",
      windowId,
      "-F",
      tmuxFormats.panes,
    ]);
    return rows(stdout).map(paneFromTmuxRow);
  }

  async getSurfaceCwd({ surfaceId } = {}) {
    requireRuntimeId(surfaceId, "surface");
    return (
      await this.tmux(["display-message", "-p", "-t", surfaceId, "#{pane_current_path}"])
    ).trim();
  }

  async getSurfaceContext({ surfaceId } = {}) {
    requireRuntimeId(surfaceId, "surface");
    const stdout = await this.tmux([
      "display-message",
      "-p",
      "-t",
      surfaceId,
      "#{window_id}\t#{session_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_tty}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}\t#{pane_mode}\t#{pane_pid}\t#{pane_title}",
    ]);
    const [
      windowId = "",
      sessionId = "",
      sessionName = "",
      windowIndex = "",
      windowName = "",
      resolvedPaneId = "",
      paneIndex = "",
      paneActive = "",
      command = "",
      tty = "",
      cwd = "",
      width = "",
      height = "",
      mode = "",
      pid = "",
      ...titleParts
    ] = stdout.trimEnd().split("\t");
    return {
      windowInfo: {
        windowId,
        sessionId,
        sessionName,
        windowIndex: Number(windowIndex),
        windowName,
      },
      pane: {
        id: resolvedPaneId || surfaceId,
        surfaceId: resolvedPaneId || surfaceId,
        kind: "tmux-pane",
        index: Number(paneIndex),
        active: paneActive === "1",
        command,
        tty,
        cwd,
        width: Number(width || 0),
        height: Number(height || 0),
        inCopyMode: isScrollbackMode(mode),
        pid: Number(pid || 0),
        title: titleParts.join("\t"),
      },
    };
  }

  async captureSurface({ surfaceId, mode = "tail", lines, ansi = false } = {}) {
    requireRuntimeId(surfaceId, "surface");
    const args = ["capture-pane", "-p", "-t", surfaceId];
    if (ansi) args.push("-e");
    if (mode === "full") {
      args.push("-S", "-", "-E", "-");
    } else if (mode === "screen") {
      // No range flags: current visible surface.
    } else {
      args.push("-S", `-${lines}`, "-E", "-");
    }
    return this.tmux(args, {
      maxBuffer: mode === "full" ? 16 * 1024 * 1024 : 8 * 1024 * 1024,
    });
  }

  async createWindowAfter({ windowId, cwd = "", name = "", command = "" } = {}) {
    return this.createWindow({ afterWindowId: windowId, cwd, name, command });
  }

  async pasteTextToSurface({ surfaceId, text } = {}) {
    requireRuntimeId(surfaceId, "surface");
    const bufferName = `tmux-mobile-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    const cleanText = String(text || "")
      .replace(/\r\n?/g, "\n")
      .replace(/\x1b\[(?:200|201)~/g, "");
    await this.tmux(["set-buffer", "-b", bufferName, cleanText]);
    await this.tmux(["paste-buffer", "-dpr", "-b", bufferName, "-t", surfaceId]);
  }

  async sendKeyToSurface({ surfaceId, key } = {}) {
    requireRuntimeId(surfaceId, "surface");
    await this.tmux(["send-keys", "-t", surfaceId, key]);
  }

  async exitSurfaceModeIfNeeded({ surfaceId } = {}) {
    requireRuntimeId(surfaceId, "surface");
    let mode = "";
    try {
      mode = (
        await this.tmux(["display-message", "-p", "-t", surfaceId, "#{pane_mode}"])
      ).trim();
    } catch {
      return false;
    }
    if (!isScrollbackMode(mode)) return false;
    await this.tmux(["send-keys", "-t", surfaceId, "-X", "cancel"]);
    return true;
  }

  async sendTextToSurface({
    surfaceId,
    text,
    enter = false,
    pasteEnterDelayMs = 0,
  } = {}) {
    await this.exitSurfaceModeIfNeeded({ surfaceId });
    await this.pasteTextToSurface({ surfaceId, text });
    if (enter) {
      if (pasteEnterDelayMs > 0) await delay(pasteEnterDelayMs);
      await this.sendKeyToSurface({ surfaceId, key: "Enter" });
      return { mode: "paste-buffer", sentEnter: true };
    }
    return { mode: "paste-buffer", sentEnter: false };
  }
}
