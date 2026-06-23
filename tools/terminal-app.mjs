#!/usr/bin/env node

// Terminal client for tmux-mobile. It deliberately uses the same HTTP API that
// the browser UI uses: /api/machines, /api/tree, /api/window-view, /api/send,
// and /api/key. In controller mode it authenticates with Google device login
// and stores a browser-session bearer token, not an agent registration token.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const DEFAULT_URL = process.env.TMUX_MOBILE_URL || "https://eng.impo.ai";
const CONFIG_PATH =
  process.env.TMUX_MOBILE_TERMINAL_CONFIG ||
  path.join(os.homedir(), ".config", "tmux-mobile", "terminal.json");
const DEFAULT_LINES = 80;
const LOGIN_POLL_FLOOR_MS = 1000;

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    login: false,
    token: process.env.TMUX_MOBILE_SESSION_TOKEN || "",
    lines: DEFAULT_LINES,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") args.url = argv[++i] || args.url;
    else if (arg === "--login") args.login = true;
    else if (arg === "--token") args.token = argv[++i] || "";
    else if (arg === "--lines") args.lines = Number(argv[++i]) || DEFAULT_LINES;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (!arg.startsWith("-")) args.url = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  args.lines = clampLines(args.lines);
  return args;
}

function usage() {
  console.log(`Usage: node tools/terminal-app.mjs [controller-url] [options]

Options:
  --url URL       Controller/local server URL. Default: ${DEFAULT_URL}
  --login         Force Google device login before connecting
  --token TOKEN   Use an existing tmux-mobile session bearer token
  --lines N       Capture line count for show/open. Default: ${DEFAULT_LINES}

Commands inside the app:
  machines        List visible machines
  use <n|id>      Select a machine
  tree            List sessions/windows on the selected machine
  all             List windows across every visible machine
  open <n|id>     Open a listed window and show its active pane
  show [lines]    Capture the current pane
  send <text>     Paste text and press Enter
  type <text>     Paste text without Enter
  key <key>       Send a direct key, e.g. Enter, C-c, Escape, Tab, Up
  agents          List detected agent windows across machines
  agent <n>       Open one of the listed agent windows
  where           Show the current target
  login           Re-run device login
  help            Show this help
  quit            Exit
`);
}

function normalizeBaseUrl(inputUrl) {
  let value = String(inputUrl || DEFAULT_URL).trim();
  if (!value) value = DEFAULT_URL;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const looksLocal = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(value);
    value = `${looksLocal ? "http" : "https"}://${value}`;
  }
  const url = new URL(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.origin;
}

function controllerKey(baseUrl) {
  return new URL(baseUrl).origin;
}

async function loadConfig() {
  try {
    return JSON.parse((await readFile(CONFIG_PATH, "utf8")) || "{}");
  } catch {
    return {};
  }
}

async function saveConfig(config) {
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function storedSession(config, baseUrl) {
  const item = config.controllers?.[controllerKey(baseUrl)];
  if (!item?.sessionToken) return null;
  if (item.expiresAt && Date.parse(item.expiresAt) <= Date.now() + 60_000) return null;
  return item;
}

async function storeSession(config, baseUrl, body) {
  config.controllers ||= {};
  config.controllers[controllerKey(baseUrl)] = {
    sessionToken: body.sessionToken,
    user: body.user || {},
    expiresAt: new Date(Date.now() + Number(body.sessionExpiresIn || 0) * 1000).toISOString(),
    savedAt: new Date().toISOString(),
  };
  await saveConfig(config);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ApiError extends Error {
  constructor(message, status = 0, body = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

class TmuxMobileClient {
  constructor(baseUrl, { token = "" } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token;
  }

  url(pathname) {
    return new URL(pathname, this.baseUrl);
  }

  async request(pathname, options = {}) {
    const headers = { accept: "application/json", ...(options.headers || {}) };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let body = options.body;
    if (
      body !== undefined &&
      body !== null &&
      typeof body !== "string" &&
      !(body instanceof Uint8Array)
    ) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(body);
    }
    if (options.machineId && options.machineId !== "local") {
      headers["x-machine-id"] = options.machineId;
    }
    let response;
    try {
      response = await fetch(this.url(pathname), {
        method: options.method || (body === undefined ? "GET" : "POST"),
        headers,
        body,
      });
    } catch (error) {
      throw new ApiError(connectionErrorMessage(this.baseUrl, error), 0);
    }
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await response.json().catch(() => ({}))
      : await response.text().catch(() => "");
    if (!response.ok) {
      const message =
        data && typeof data === "object" && data.error
          ? data.error
          : `HTTP ${response.status}`;
      throw new ApiError(message, response.status, data);
    }
    return data;
  }

  async publicPost(pathname, body = {}) {
    let response;
    try {
      response = await fetch(this.url(pathname), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new ApiError(connectionErrorMessage(this.baseUrl, error), 0);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(data.error || `HTTP ${response.status}`, response.status, data);
    return data;
  }
}

function connectionErrorMessage(baseUrl, error) {
  const cause = error?.cause;
  const details = cause?.code || cause?.message || error?.message || "connection failed";
  const localHint =
    new URL(baseUrl).hostname === "127.0.0.1" || new URL(baseUrl).hostname === "localhost"
      ? " Start the local server with `npm start`, or pass the controller URL: `npm run terminal -- https://eng.impo.ai`."
      : "";
  return `Could not connect to ${baseUrl} (${details}).${localHint}`;
}

async function loginTerminal(client, config) {
  const start = await client.publicPost("/auth/device/start", {});
  console.log("tmux-mobile terminal needs Google device login.");
  console.log(`Controller: ${client.baseUrl}`);
  console.log(`Open in a browser: ${start.verificationUrlComplete || start.verificationUrl}`);
  if (!start.verificationUrlComplete) console.log(`Enter code: ${start.userCode}`);
  console.log("Waiting for Google authorization...");

  let intervalMs =
    Math.max(Number(start.interval || 5) * 1000, LOGIN_POLL_FLOOR_MS);
  const expiresAt = Date.now() + Math.max(Number(start.expiresIn || 600), 60) * 1000;
  while (Date.now() < expiresAt) {
    await sleep(intervalMs);
    const response = await fetch(client.url("/auth/device/poll"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ id: start.id }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 202) {
      intervalMs = Math.max(Number(body.interval || start.interval || 5) * 1000, LOGIN_POLL_FLOOR_MS);
      continue;
    }
    if (!response.ok) {
      throw new ApiError(body.error || `Device login failed with HTTP ${response.status}`, response.status, body);
    }
    if (!body.sessionToken) {
      throw new Error(
        `Device login succeeded, but ${client.baseUrl} did not return a terminal session token. Deploy the controller change first, or run against a local server started from this checkout.`,
      );
    }
    client.token = body.sessionToken;
    await storeSession(config, client.baseUrl, body);
    console.log(`Google login complete: ${body.user?.email || "Google user"}.`);
    console.log(`Terminal session saved: ${CONFIG_PATH}`);
    return body;
  }
  throw new Error("Device login expired");
}

async function ensureRuntime(client, config, args) {
  if (args.token) client.token = args.token;
  if (!client.token) {
    const stored = storedSession(config, client.baseUrl);
    if (stored) client.token = stored.sessionToken;
  }
  if (args.login) await loginTerminal(client, config);
  try {
    return await client.request("/api/runtime");
  } catch (error) {
    if (error.status !== 401) throw error;
    await loginTerminal(client, config);
    return client.request("/api/runtime");
  }
}

function clampLines(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LINES;
  return Math.max(10, Math.min(5000, Math.floor(n)));
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function cleanOneLine(value, fallback = "") {
  return String(value || fallback)
    .replace(/\s+/g, " ")
    .trim();
}

function machineLabel(machine) {
  return machine.hostname || machine.machineId || machine.id || "local";
}

function machineStatus(machine) {
  const parts = [];
  if (machine.ownerEmail) parts.push(machine.ownerEmail);
  if (machine.muxes?.length) parts.push(machine.muxes.map((item) => item.mux || item.kind).join("+"));
  else if (machine.mux) parts.push(machine.mux);
  if (machine.stale) parts.push("stale");
  if (machine.agentCount != null) parts.push(`${machine.agentCount} agents`);
  return parts.join(", ");
}

function windowLabel(win, session = null) {
  const sessionName = session?.name || win.sessionName || win.sessionId || "?";
  const bits = [
    `${sessionName}:${win.index}`,
    win.name || "(unnamed)",
    win.cwd ? `cwd=${win.cwd}` : "",
    win.activeCommand ? `cmd=${win.activeCommand}` : "",
  ].filter(Boolean);
  return bits.join(" | ");
}

function paneLabel(pane) {
  return [pane.id, pane.command, pane.cwd].filter(Boolean).join(" | ");
}

function findBySpec(items, spec, labelFn = () => "") {
  const raw = String(spec || "").trim();
  if (!raw) return null;
  const asNumber = Number(raw);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= items.length) {
    return items[asNumber - 1];
  }
  const lower = raw.toLowerCase();
  return (
    items.find((item) => {
      const candidates = [
        item.id,
        item.machineId,
        item.rawMachineId,
        item.hostname,
        item.rawHostname,
        item.machineAlias,
        item.windowId,
        item.paneId,
        labelFn(item),
      ];
      return candidates.some((candidate) => String(candidate || "").toLowerCase() === lower);
    }) || null
  );
}

class TerminalApp {
  constructor(client, runtime, { lines = DEFAULT_LINES } = {}) {
    this.client = client;
    this.runtime = runtime;
    this.lines = clampLines(lines);
    this.machines = [];
    this.machine = null;
    this.sessions = [];
    this.windows = [];
    this.windowChoices = [];
    this.agentChoices = [];
    this.currentWindow = null;
    this.currentPaneId = "";
    this.currentPanes = [];
  }

  get hubMode() {
    return this.runtime.mode === "hub";
  }

  machineId() {
    return this.hubMode ? this.machine?.id || "" : "";
  }

  async boot() {
    await this.refreshMachines();
    if (this.machines.length === 1) {
      await this.selectMachine(this.machines[0]);
    }
    console.log(`Connected to ${this.client.baseUrl} (${this.runtime.mode || "local"}).`);
    this.printMachines();
    if (this.machine) await this.refreshTree({ print: true });
    console.log("Type help for commands.");
  }

  async refreshMachines() {
    if (!this.hubMode) {
      this.machines = [{ id: "local", hostname: "local", online: true }];
      this.machine ||= this.machines[0];
      return this.machines;
    }
    this.machines = asList(await this.client.request("/api/machines"));
    if (this.machine) {
      const stillOnline = this.machines.find((machine) => machine.id === this.machine.id);
      this.machine = stillOnline || null;
    }
    return this.machines;
  }

  printMachines() {
    if (this.machines.length === 0) {
      console.log("No machines online.");
      return;
    }
    console.log("\nMachines");
    this.machines.forEach((machine, index) => {
      const selected = this.machine?.id === machine.id ? "*" : " ";
      const status = machineStatus(machine);
      console.log(
        `${selected} ${String(index + 1).padStart(2, " ")}. ${machineLabel(machine)}${status ? ` (${status})` : ""}`,
      );
    });
  }

  async selectMachine(machine) {
    this.machine = machine;
    this.sessions = [];
    this.windows = [];
    this.windowChoices = [];
    this.currentWindow = null;
    this.currentPaneId = "";
    await this.refreshTree({ print: false });
  }

  async refreshTree({ print = false } = {}) {
    if (!this.machine) {
      console.log("Select a machine first: use <n|id>");
      return;
    }
    const tree = await this.client.request("/api/tree", { machineId: this.machineId() });
    this.sessions = asList(tree.sessions);
    this.windows = asList(tree.windows);
    this.windowChoices = this.windows.map((win) => ({
      ...win,
      session: this.sessions.find((session) => session.id === win.sessionId) || null,
    }));
    if (print) this.printTree();
  }

  printTree() {
    const label = this.machine ? machineLabel(this.machine) : "no machine";
    console.log(`\nWindows on ${label}`);
    if (this.windowChoices.length === 0) {
      console.log("No tmux/rmux windows.");
      return;
    }
    this.windowChoices.forEach((win, index) => {
      const selected = this.currentWindow?.id === win.id ? "*" : " ";
      console.log(`${selected} ${String(index + 1).padStart(2, " ")}. ${windowLabel(win, win.session)}`);
    });
  }

  async listAllWindows() {
    await this.refreshMachines();
    if (this.machines.length === 0) {
      console.log("No machines online.");
      return;
    }
    for (const machine of this.machines) {
      const previous = this.machine;
      this.machine = machine;
      try {
        await this.refreshTree({ print: false });
        console.log(`\n${machineLabel(machine)}`);
        if (this.windowChoices.length === 0) {
          console.log("  No tmux/rmux windows.");
          continue;
        }
        this.windowChoices.forEach((win) => {
          console.log(`  ${windowLabel(win, win.session)}`);
        });
      } catch (error) {
        console.log(`  Could not load windows: ${error.message || String(error)}`);
      } finally {
        this.machine = previous;
      }
    }
    if (this.machine) await this.refreshTree({ print: false }).catch(() => {});
  }

  async openWindow(spec) {
    if (this.windowChoices.length === 0) await this.refreshTree();
    const win = findBySpec(this.windowChoices, spec, (item) => windowLabel(item, item.session));
    if (!win) {
      console.log(`Window not found: ${spec || ""}`);
      return;
    }
    this.currentWindow = win;
    await this.loadWindowView();
  }

  async loadWindowView({ lines = this.lines } = {}) {
    if (!this.currentWindow) {
      console.log("Open a window first: open <n|id>");
      return;
    }
    const query = new URLSearchParams({
      windowId: this.currentWindow.id,
      lines: String(clampLines(lines)),
    });
    const view = await this.client.request(`/api/window-view?${query}`, {
      machineId: this.machineId(),
    });
    this.currentPanes = asList(view.panes);
    this.currentPaneId = view.activePaneId || this.currentPanes.find((pane) => pane.active)?.id || "";
    console.log(`\n== ${machineLabel(this.machine)} | ${windowLabel(this.currentWindow, this.currentWindow.session)} ==`);
    if (this.currentPaneId) {
      const pane = this.currentPanes.find((item) => item.id === this.currentPaneId);
      if (pane) console.log(`-- ${paneLabel(pane)} --`);
    }
    const capture = view.capture || {};
    if (capture.error) {
      console.log(`Capture failed: ${capture.error}`);
      return;
    }
    console.log(capture.text || "[no visible output]");
  }

  async show(lines = this.lines) {
    if (!this.currentPaneId) {
      if (this.currentWindow) return this.loadWindowView({ lines });
      console.log("Open a window first: open <n|id>");
      return;
    }
    const query = new URLSearchParams({
      paneId: this.currentPaneId,
      lines: String(clampLines(lines)),
    });
    const result = await this.client.request(`/api/capture?${query}`, {
      machineId: this.machineId(),
    });
    console.log(result.text || "[no visible output]");
  }

  async send(text, { enter = true } = {}) {
    if (!this.currentPaneId) {
      console.log("Open a window first: open <n|id>");
      return;
    }
    await this.client.request("/api/send", {
      method: "POST",
      machineId: this.machineId(),
      body: { paneId: this.currentPaneId, text, enter },
    });
    await sleep(250);
    await this.show();
  }

  async key(key) {
    if (!this.currentPaneId) {
      console.log("Open a window first: open <n|id>");
      return;
    }
    await this.client.request("/api/key", {
      method: "POST",
      machineId: this.machineId(),
      body: { paneId: this.currentPaneId, key },
    });
    await sleep(150);
    await this.show();
  }

  async listAgents() {
    const result = await this.client.request("/api/command-center");
    const machines = new Map(asList(result.machines).map((machine) => [machine.id, machine]));
    this.agentChoices = asList(result.agents).map((agent) => ({
      ...agent,
      machine: machines.get(agent.machineId) || null,
    }));
    console.log("\nAgents");
    if (this.agentChoices.length === 0) {
      console.log("No detected agent windows.");
      return;
    }
    this.agentChoices.forEach((agent, index) => {
      const machine = agent.machine || {};
      const title = [
        machineLabel(machine) || agent.machineHostname || agent.machineId,
        `${agent.sessionName || "?"}:${agent.windowIndex ?? "?"}`,
        agent.windowName || "",
        agent.kind || "",
        agent.turn || "",
      ].filter(Boolean);
      const prompt = cleanOneLine(agent.lastUserText || "", "");
      console.log(`${String(index + 1).padStart(2, " ")}. ${title.join(" | ")}`);
      if (prompt) console.log(`    ${prompt.slice(0, 160)}`);
    });
  }

  async openAgent(spec) {
    if (this.agentChoices.length === 0) await this.listAgents();
    const agent = findBySpec(this.agentChoices, spec, (item) =>
      [item.machineHostname, item.sessionName, item.windowName].filter(Boolean).join(" "),
    );
    if (!agent) {
      console.log(`Agent not found: ${spec || ""}`);
      return;
    }
    if (this.hubMode) {
      const machine =
        this.machines.find((item) => item.id === agent.machineId) ||
        this.machines.find((item) => item.hostname === agent.machineHostname);
      if (!machine) {
        console.log(`Machine is not online: ${agent.machineHostname || agent.machineId}`);
        return;
      }
      this.machine = machine;
    }
    await this.refreshTree();
    const win =
      this.windowChoices.find((item) => item.id === agent.windowId) ||
      this.windowChoices.find(
        (item) =>
          item.session?.name === agent.sessionName &&
          Number(item.index) === Number(agent.windowIndex),
      );
    if (!win) {
      console.log("The agent window is no longer present.");
      return;
    }
    this.currentWindow = win;
    await this.loadWindowView();
  }

  where() {
    console.log(`Server: ${this.client.baseUrl} (${this.runtime.mode || "local"})`);
    console.log(`Machine: ${this.machine ? machineLabel(this.machine) : "(none)"}`);
    console.log(
      `Window: ${
        this.currentWindow
          ? windowLabel(this.currentWindow, this.currentWindow.session)
          : "(none)"
      }`,
    );
    console.log(`Pane: ${this.currentPaneId || "(none)"}`);
  }

  async handle(line, config) {
    const trimmed = line.trim();
    if (!trimmed) return;
    const [commandRaw, ...restParts] = trimmed.split(/\s+/);
    const command = commandRaw.toLowerCase();
    const rest = trimmed.slice(commandRaw.length).trim();
    if (command === "quit" || command === "q" || command === "exit") return false;
    if (command === "help" || command === "?") {
      usage();
      return true;
    }
    if (command === "machines" || command === "m") {
      await this.refreshMachines();
      this.printMachines();
      return true;
    }
    if (command === "use") {
      const machine = findBySpec(this.machines, rest);
      if (!machine) console.log(`Machine not found: ${rest}`);
      else {
        await this.selectMachine(machine);
        console.log(`Selected ${machineLabel(machine)}.`);
        this.printTree();
      }
      return true;
    }
    if (command === "tree" || command === "windows" || command === "ls") {
      await this.refreshTree({ print: true });
      return true;
    }
    if (command === "all") {
      await this.listAllWindows();
      return true;
    }
    if (command === "open" || command === "o") {
      await this.openWindow(rest);
      return true;
    }
    if (command === "show" || command === "s") {
      await this.show(restParts[0] ? clampLines(restParts[0]) : this.lines);
      return true;
    }
    if (command === "send") {
      await this.send(rest, { enter: true });
      return true;
    }
    if (command === "type" || command === "paste") {
      await this.send(rest, { enter: false });
      return true;
    }
    if (command === "key" || command === "k") {
      await this.key(restParts[0] || "");
      return true;
    }
    if (command === "agents" || command === "a") {
      await this.listAgents();
      return true;
    }
    if (command === "agent") {
      await this.openAgent(rest);
      return true;
    }
    if (command === "where" || command === "w") {
      this.where();
      return true;
    }
    if (command === "lines") {
      this.lines = clampLines(restParts[0]);
      console.log(`Lines: ${this.lines}`);
      return true;
    }
    if (command === "login") {
      await loginTerminal(this.client, config);
      this.runtime = await this.client.request("/api/runtime");
      await this.refreshMachines();
      this.printMachines();
      return true;
    }
    console.log(`Unknown command: ${commandRaw}. Type help.`);
    return true;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const baseUrl = normalizeBaseUrl(args.url);
  const config = await loadConfig();
  const client = new TmuxMobileClient(baseUrl, { token: args.token });
  const runtime = await ensureRuntime(client, config, args);
  const app = new TerminalApp(client, runtime, { lines: args.lines });
  await app.boot();

  const rl = readline.createInterface({ input, output, historySize: 100 });
  try {
    while (true) {
      const prompt = app.machine
        ? `${machineLabel(app.machine)}${app.currentWindow ? `:${app.currentWindow.index}` : ""}> `
        : "tmux-mobile> ";
      const line = await rl.question(prompt);
      try {
        const keepGoing = await app.handle(line, config);
        if (keepGoing === false) break;
      } catch (error) {
        console.error(`Error: ${error.message || String(error)}`);
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
