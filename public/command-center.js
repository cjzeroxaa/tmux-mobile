// Command Center — separate top-level page. Polls /api/command-center on
// a slow cadence, drops non-agent windows, renders one card per agent
// with the last user prompt + last assistant response taken verbatim from
// the agent's JSONL transcript. No tmux capture, no LLM summary.

const POLL_MS = 4000;

const els = {
  list: document.querySelector("#ccList"),
  status: document.querySelector("#ccStatus"),
  refresh: document.querySelector("#ccRefresh"),
  filterRow: document.querySelector("#ccFilterRow"),
  sortSelect: document.querySelector("#ccSort"),
};

// Persisted view prefs — sort + status/machine filters stay across reloads
// so a user's "only show working on mac-mini" lens is sticky.
function loadPrefs() {
  try {
    const raw = localStorage.getItem("tmux-mobile-cc-prefs");
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch { return {}; }
}
function savePrefs(prefs) {
  try {
    localStorage.setItem("tmux-mobile-cc-prefs", JSON.stringify(prefs));
  } catch {}
}
const SAVED = loadPrefs();

const state = {
  agents: [],
  loading: false,
  // Track which (windowId, section) cards the user expanded so a refresh
  // doesn't collapse what they were reading.
  expanded: new Set(),
  pollTimer: null,
  lastError: "",
  // Filter sets are Sets of allowed values. Empty = "show all" for that
  // category. Hydrated from localStorage on boot.
  sortBy: SAVED.sortBy || "status",
  filterMachines: new Set(SAVED.filterMachines || []),
  filterStatuses: new Set(SAVED.filterStatuses || []),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function abbrevHome(value) {
  return String(value || "")
    .replace(/^\/(?:Users|home)\/[^/]+/, "~")
    .replace(/^\/root(?=\/|$)/, "~");
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function setStatus(text) {
  els.status.textContent = text;
}

function mainAppHref({ machineId, sessionName, sessionId, windowIndex, windowName }) {
  // Main app reads its URL target via session + window query params (see
  // public/app.js readUrlTarget). machineId comes along too so controller
  // mode lands on the right machine without an extra round-trip.
  const params = new URLSearchParams({
    session: sessionName || sessionId,
    window: String(windowIndex),
  });
  if (machineId) params.set("machineId", machineId);
  if (windowName) params.set("windowName", windowName);
  return `/app/?${params.toString()}`;
}

// Apply filters + sort to the current agent list. Pure function — call
// before renderAgents and feed it the result.
function filterAndSort(agents) {
  let out = agents;
  if (state.filterStatuses.size > 0) {
    out = out.filter((a) => state.filterStatuses.has(a.status));
  }
  if (state.filterMachines.size > 0) {
    out = out.filter((a) =>
      state.filterMachines.has(a.machineId || a.machineHostname || ""),
    );
  }
  const cmp = sortComparator(state.sortBy);
  return [...out].sort(cmp);
}

function sortComparator(by) {
  switch (by) {
    case "machine":
      return (a, b) =>
        (a.machineHostname || a.machineId || "").localeCompare(
          b.machineHostname || b.machineId || "",
        ) || a.windowIndex - b.windowIndex;
    case "recent":
      return (a, b) => {
        // null/missing timestamps sort last
        const ta = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
        const tb = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
        return tb - ta;
      };
    case "name":
      return (a, b) => (a.windowName || "").localeCompare(b.windowName || "");
    case "status":
    default:
      // Working first, then by window index — keep the previous default.
      return (a, b) => {
        if (a.status === b.status) return a.windowIndex - b.windowIndex;
        return a.status === "running" ? -1 : 1;
      };
  }
}

// Rebuild the chip row whenever the agent list changes (e.g. a new
// machine came online). Status chips are stable; machine chips come from
// the distinct machineIds seen in the payload.
function renderFilterRow() {
  const row = els.filterRow;
  row.innerHTML = "";
  // Status chips first.
  for (const s of ["running", "idle"]) {
    const label = s === "running" ? "Working" : "Idle";
    const active = state.filterStatuses.has(s);
    row.append(chipButton({
      label,
      active,
      kind: "status",
      onTap: () => toggleFilter("filterStatuses", s),
    }));
  }
  // Then per-machine chips, only when more than one machine is in play.
  const machines = new Map(); // id -> hostname
  for (const a of state.agents) {
    const id = a.machineId || a.machineHostname || "";
    if (!id) continue;
    if (!machines.has(id)) machines.set(id, a.machineHostname || id);
  }
  if (machines.size > 1) {
    const sep = document.createElement("span");
    sep.className = "cc-filter-sep";
    row.append(sep);
    for (const [id, hostname] of machines) {
      const active = state.filterMachines.has(id);
      row.append(chipButton({
        label: hostname,
        active,
        kind: "machine",
        onTap: () => toggleFilter("filterMachines", id),
      }));
    }
  }
}

function chipButton({ label, active, kind, onTap }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `cc-filter-chip cc-filter-chip-${kind}${active ? " is-active" : ""}`;
  btn.textContent = label;
  btn.addEventListener("click", onTap);
  return btn;
}

function toggleFilter(setName, value) {
  const s = state[setName];
  if (s.has(value)) s.delete(value);
  else s.add(value);
  persistPrefs();
  renderFilterRow();
  renderAgents();
}

function persistPrefs() {
  savePrefs({
    sortBy: state.sortBy,
    filterStatuses: [...state.filterStatuses],
    filterMachines: [...state.filterMachines],
  });
}

function renderEmpty() {
  els.list.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "cc-empty";
  empty.textContent = state.lastError
    ? `Couldn't load agents — ${state.lastError}`
    : "No Codex or Claude Code agents running right now.";
  els.list.append(empty);
}

function renderSection({ className, label, text, expandedKey }) {
  const wrap = document.createElement("div");
  wrap.className = `cc-section ${className}`;
  if (state.expanded.has(expandedKey)) wrap.classList.add("is-expanded");

  const labelEl = document.createElement("div");
  labelEl.className = "cc-section-label";
  labelEl.textContent = label;

  const body = document.createElement("div");
  body.className = "cc-section-text";
  if (!text) {
    body.classList.add("is-empty");
    body.textContent = "(nothing yet)";
  } else {
    body.textContent = text;
  }

  body.addEventListener("click", () => {
    if (state.expanded.has(expandedKey)) state.expanded.delete(expandedKey);
    else state.expanded.add(expandedKey);
    wrap.classList.toggle("is-expanded");
  });

  wrap.append(labelEl, body);
  return wrap;
}

function renderCard(agent) {
  const card = document.createElement("article");
  card.className = `cc-card${agent.status === "running" ? " is-running" : ""}`;

  const header = document.createElement("div");
  header.className = "cc-card-header";
  // In controller mode the controller tags each agent with the machine it
  // came from + the email of whoever registered it. Show both as a
  // leading chip pair so you can tell whose Mac the window lives on at a
  // glance. Local mode skips both (fields absent).
  const machineChip = agent.machineHostname
    ? `<span class="cc-machine-chip" title="${escapeHtml(agent.machineId || "")}">${escapeHtml(agent.machineHostname)}</span>`
    : "";
  // Strip @domain for visual compactness; full email lives in the title.
  const ownerLocal = (agent.machineOwnerId || "").replace(/@.*$/, "");
  const ownerChip = agent.machineOwnerId
    ? `<span class="cc-owner-chip" title="${escapeHtml(agent.machineOwnerId)}">${escapeHtml(ownerLocal)}</span>`
    : "";
  header.innerHTML = `
    ${machineChip}
    ${ownerChip}
    <span class="cc-card-title">
      <span>${agent.windowIndex}: ${escapeHtml(agent.windowName || "(unnamed)")}</span>
      <span class="cc-card-session">· ${escapeHtml(agent.sessionName || "")}</span>
    </span>
    <span class="cc-kind-chip">${escapeHtml(agent.kind)}</span>
    <span class="cc-status-pill${agent.status === "running" ? " is-running" : ""}">
      ${agent.status === "running" ? "Working" : "Idle"}
    </span>
  `;
  card.append(header);

  const cwd = document.createElement("div");
  cwd.className = "cc-card-cwd";
  cwd.textContent = abbrevHome(agent.cwd);
  card.append(cwd);

  card.append(
    renderSection({
      className: "user",
      label: "Last prompt",
      text: agent.lastUserText,
      expandedKey: `${agent.windowId}::user`,
    }),
  );
  card.append(
    renderSection({
      className: "assistant",
      label: "Last response",
      text: agent.lastAssistantText,
      expandedKey: `${agent.windowId}::assistant`,
    }),
  );

  const footer = document.createElement("div");
  footer.className = "cc-card-footer";
  footer.innerHTML = `
    <span>${agent.turnCount} turn${agent.turnCount === 1 ? "" : "s"} · session <code>${escapeHtml((agent.agentSessionId || "").slice(0, 8))}</code></span>
    <a href="${escapeHtml(mainAppHref(agent))}">Open →</a>
  `;
  card.append(footer);

  return card;
}

function renderAgents() {
  if (state.agents.length === 0) {
    renderEmpty();
    return;
  }
  const filtered = filterAndSort(state.agents);
  els.list.innerHTML = "";
  if (filtered.length === 0) {
    const note = document.createElement("div");
    note.className = "cc-empty";
    note.textContent = "No agents match the current filters.";
    els.list.append(note);
    return;
  }
  for (const agent of filtered) {
    els.list.append(renderCard(agent));
  }
}

async function loadAgents() {
  if (state.loading) return;
  state.loading = true;
  if (state.agents.length === 0) setStatus("Loading…");
  try {
    const res = await fetch("/api/command-center", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.agents = Array.isArray(data.agents) ? data.agents : [];
    state.lastError = "";
    setStatus(`${state.agents.length} agent${state.agents.length === 1 ? "" : "s"} · refreshed ${nowLabel()}`);
    renderFilterRow();
    renderAgents();
  } catch (error) {
    state.lastError = error.message || String(error);
    setStatus(`Refresh failed at ${nowLabel()}`);
    if (state.agents.length === 0) renderEmpty();
  } finally {
    state.loading = false;
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = window.setInterval(loadAgents, POLL_MS);
}
function stopPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

els.refresh.addEventListener("click", () => loadAgents());

// Sort dropdown — hydrate the persisted selection, fire on change.
els.sortSelect.value = state.sortBy;
els.sortSelect.addEventListener("change", () => {
  state.sortBy = els.sortSelect.value;
  persistPrefs();
  renderAgents();
});

// Pause polling when the tab is backgrounded — every poll fires N
// processTree + lsof calls on the host, no reason to keep doing that
// while the user can't see the result.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else { loadAgents(); startPolling(); }
});

loadAgents();
startPolling();
