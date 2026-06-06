// Command Center — separate top-level page. Polls /api/command-center on
// a slow cadence, drops non-agent windows, renders one card per agent
// with the last user prompt + last assistant response taken verbatim from
// the agent's JSONL transcript. No tmux capture, no LLM summary.

const POLL_MS = 4000;

const els = {
  list: document.querySelector("#ccList"),
  status: document.querySelector("#ccStatus"),
  refresh: document.querySelector("#ccRefresh"),
};

const state = {
  agents: [],
  loading: false,
  // Track which (windowId, section) cards the user expanded so a refresh
  // doesn't collapse what they were reading.
  expanded: new Set(),
  pollTimer: null,
  lastError: "",
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

function mainAppHref({ sessionId, windowIndex }) {
  // Main app reads its URL target via session + window query params (see
  // public/app.js readUrlTarget). Stay structurally identical so the deep
  // link drops the user straight into that window.
  const params = new URLSearchParams({
    session: sessionId,
    window: String(windowIndex),
  });
  return `/?${params.toString()}`;
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
  header.innerHTML = `
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
  els.list.innerHTML = "";
  // Sort so the "Working" cards bubble to the top — that's where the
  // user's attention is needed.
  const sorted = [...state.agents].sort((a, b) => {
    if (a.status === b.status) return a.windowIndex - b.windowIndex;
    return a.status === "running" ? -1 : 1;
  });
  for (const agent of sorted) {
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

// Pause polling when the tab is backgrounded — every poll fires N
// processTree + lsof calls on the host, no reason to keep doing that
// while the user can't see the result.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else { loadAgents(); startPolling(); }
});

loadAgents();
startPolling();
