import { isVisionDevice, visionTextPreview } from "./vision-input.js";
import { bindStreamingDictation } from "./streaming-asr.js";
let cancelVisionDictation = () => {};
import { syncInputWakeLock } from "./screen-awake.mjs";
import { draftLibrary, draftLibraryUrl, draftMachineName } from "./draft-library.mjs";
const $ = (id) => document.getElementById(id),
  params = new URLSearchParams(location.search);
const context = {
  machineId: params.get("machineId") || "",
  kind: params.get("kind") || "",
  sessionId: params.get("sessionId") || "",
};
const embedded = params.get("embedded") === "1";
const sort = params.get("sort") === "machine" ? "machine" : "newest";
const libraryBody = $("libraryBody"), libraryToggle = $("toggleLibrary");
const libraryScrollKey = `tmux-mobile-draft-library-scroll:${JSON.stringify({ embedded, ...context, sort })}`;
let libraryScrollTop = 0;
try {
  libraryScrollTop = Math.max(0, Number(sessionStorage.getItem(libraryScrollKey)) || 0);
} catch {}
function rememberLibraryPosition() {
  if (!libraryBody.hidden && libraryBody.getClientRects().length && $("draftList").childElementCount) {
    libraryScrollTop = libraryBody.scrollTop;
  }
}
function restoreLibraryPosition() {
  if (!libraryBody.hidden) libraryBody.scrollTop = libraryScrollTop;
}
function syncLibraryToggle() {
  const collapsed = !embedded && document.documentElement.classList.contains("library-collapsed");
  libraryBody.hidden = collapsed;
  libraryToggle.setAttribute("aria-expanded", String(!collapsed));
  libraryToggle.setAttribute("aria-label", collapsed ? "Expand draft library" : "Collapse draft library");
  libraryToggle.title = libraryToggle.getAttribute("aria-label");
  restoreLibraryPosition();
}
libraryToggle.onclick = () => {
  rememberLibraryPosition();
  const collapsed = document.documentElement.classList.toggle("library-collapsed");
  syncLibraryToggle();
  try { localStorage.setItem("tmux-mobile-draft-library-collapsed", String(collapsed)); } catch {}
};
syncLibraryToggle();
for (const link of document.querySelectorAll(".all-drafts")) {
  link.href = draftLibraryUrl({ embedded });
}
$("machineFilter").onchange = () => {
  location.assign(draftLibraryUrl({ embedded, machineId: $("machineFilter").value, sort }));
};
$("sortOrder").value = sort;
$("sortOrder").onchange = () => {
  location.assign(draftLibraryUrl({ embedded, ...context, sort: $("sortOrder").value }));
};
let id = params.get("id") || "",
  detail = null,
  version = 0,
  anchor = null,
  generation = 0,
  controller,
  frameReady = false;
let busy = false;
let feedbackOpen = false;
let reviseState = "idle";
let reviseReset;
let sharingBusy = false;
const node = (tag, text, cls) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
};
const date = (t) => new Date(t).toLocaleString();
async function request(path, options = {}) {
  const r = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  if (r.status === 401) {
    $("login").hidden = false;
    $("login").href =
      `/auth/google/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
  }
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || "Request failed");
  return body;
}
function query(extra = {}) {
  return new URLSearchParams({ ...context, ...(params.get("embedded") === "1" ? { embedded: "1" } : {}), ...extra });
}
function postFrame(value) {
  if (frameReady)
    $("canvas").contentWindow.postMessage(
      { source: "tmax-host", ...value },
      "*",
    );
}
function sendComments() {
  postFrame({ type: "comments", comments: detail?.comments || [] });
}
function syncCommentForm() {
  $("selection").textContent = anchor?.quote || "Overall comment · Whole draft";
  $("clearSelection").hidden = !anchor;
  $("saveComment").disabled = busy || !version || !$("comment").value.trim();
}
function syncReviewActions() {
  const hasFeedback = detail?.comments.some((c) => c.status === "open");
  const button = $("revise");
  button.disabled = busy || reviseState !== "idle" || !hasFeedback;
  button.dataset.state = reviseState;
  button.setAttribute("aria-busy", String(reviseState === "sending"));
  button.textContent = reviseState === "sending" ? "Sending…"
    : reviseState === "sent" ? "✓ Sent to Agent" : "Ask Agent to revise";
  $("copyFeedback").disabled = busy || !hasFeedback;
}
function renderSharing() {
  const sharing = detail?.sharing;
  const enabled = sharing?.enabled === true;
  $("share").textContent = enabled ? "Share · Public" : "Share";
  $("publicSharingTitle").textContent = enabled ? "Public link is on" : "Public link is off";
  $("publicLinkRow").hidden = !enabled;
  $("publicLink").value = enabled ? new URL(sharing.path, location.origin).href : "";
  $("sharingOwnerOnly").hidden = !!sharing?.canManage;
  const toggle = $("togglePublicSharing");
  toggle.disabled = sharingBusy || !sharing?.canManage;
  toggle.setAttribute("aria-busy", String(sharingBusy));
  toggle.textContent = sharingBusy ? "Saving…" : enabled ? "Disable public link" : "Enable public link";
  $("copyPublicLink").disabled = sharingBusy || !enabled;
}
function setSharingOpen(open) {
  $("sharePanel").hidden = !open;
  $("share").setAttribute("aria-expanded", String(open));
  if (open) {
    renderSharing();
    $("sharePanel").scrollIntoView({ block: "nearest" });
  } else $("share").focus();
}
function setFeedbackOpen(open, { reveal = false } = {}) {
  feedbackOpen = !!open;
  const panel = $("feedback"), toggle = $("toggleFeedback");
  if (!feedbackOpen && panel.contains(document.activeElement)) toggle.focus();
  panel.hidden = !feedbackOpen || !version;
  toggle.setAttribute("aria-expanded", String(!panel.hidden));
  if (reveal && !panel.hidden &&
      (matchMedia("(max-width: 1150px)").matches || params.get("embedded") === "1")) {
    panel.scrollIntoView({ block: "nearest" });
  }
}
function renderComments() {
  $("comments").replaceChildren();
  for (const c of detail.comments) {
    const item = node(
      "article",
      undefined,
      `comment${c.status === "resolved" ? " is-resolved" : ""}`,
    );
    item.dataset.commentId = c.id;
    item.append(
      node("small", `v${c.version} · ${c.authorEmail} · ${date(c.createdAt)}`),
    );
    if (c.anchor?.quote) {
      const quote = node("blockquote", c.anchor.quote);
      quote.tabIndex = 0;
      quote.title = "Find quoted text";
      quote.onclick = () => postFrame({ type: "focus", id: c.id });
      quote.onkeydown = (e) => {
        if (e.key === "Enter") quote.click();
      };
      item.append(quote, node("span", "Locating…", "anchor-status"));
    } else {
      item.append(node("small", "Overall comment · Whole draft"));
    }
    item.append(node("p", c.text));
    const resolve = node(
      "button",
      c.status === "resolved" ? "Reopen" : "Resolve",
    );
    resolve.type = "button";
    resolve.onclick = () =>
      action(async () => {
        await request(`/api/drafts/comments?id=${id}`, {
          method: "PATCH",
          body: JSON.stringify({
            id: c.id,
            status: c.status === "resolved" ? "open" : "resolved",
          }),
        });
        await reloadDetail();
      });
    item.append(resolve);
    $("comments").append(item);
  }
  if (!detail.comments.length)
    $("comments").append(node("p", "No comments yet. Leave overall feedback or select text to begin."));
  syncReviewActions();
  sendComments();
}
async function reloadDetail() {
  detail = await request(`/api/drafts?id=${id}`);
  renderComments();
  renderSharing();
}
async function load({ preserveFrame = false } = {}) {
  cancelVisionDictation();
  const current = ++generation;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  $("refresh").disabled = true;
  $("status").textContent = "Loading…";
  try {
    const [list, selected] = await Promise.all([
      request("/api/drafts", { signal }),
      id ? request(`/api/drafts?id=${id}`, { signal }) : null,
    ]);
    if (current !== generation) return;
    rememberLibraryPosition();
    const library = draftLibrary(list.drafts, { ...context, sort });
    $("machineFilter").replaceChildren(node("option", `All machines (${list.drafts.length})`));
    $("machineFilter").firstChild.value = "";
    for (const machine of library.machines) {
      const option = node("option", `${machine.name} (${machine.count})`);
      option.value = machine.id;
      $("machineFilter").append(option);
    }
    if (context.machineId && !library.machines.some(m => m.id === context.machineId)) {
      const option = node("option", "Current machine (0)");
      option.value = context.machineId;
      $("machineFilter").append(option);
    }
    $("machineFilter").value = context.machineId;
    $("libraryTitle").textContent = context.sessionId ? "Session drafts" : context.machineId ? "Machine drafts" : "All drafts";
    $("scope").textContent = `${library.count} drafts · ${context.sessionId ? "This session" : context.machineId ? "This machine" : "All machines"} · Newest first${sort === "machine" ? " within each machine" : ""}`;
    $("draftList").replaceChildren();
    for (const group of library.groups) {
      if (group.name) $("draftList").append(node("h2", `${group.name} · ${group.drafts.length}`, "machine-heading"));
      for (const d of group.drafts) {
        const a = node("a", undefined, "draft-link");
        a.href = draftLibraryUrl({ embedded, ...context, sort, id: d.id });
        a.setAttribute("aria-current", String(d.id === id));
        a.append(
          node("strong", d.title),
          node("small", draftMachineName(d), "draft-machine"),
          node("small", `${d.kind} · v${d.version} · ${date(d.updatedAt)}`),
        );
        $("draftList").append(a);
      }
    }
    if (!library.count) $("draftList").append(node("p", context.sessionId ? "No drafts for this session yet. Use All drafts to browse the full library." : context.machineId ? "No drafts for this machine yet." : "No drafts yet."));
    restoreLibraryPosition();
    if (!selected) {
      $("empty").hidden = false;
      $("status").textContent = library.count
        ? ""
        : context.sessionId
          ? "No drafts for this session yet."
          : "No drafts yet.";
      return;
    }
    detail = selected;
    renderSharing();
    if (
      preserveFrame &&
      version &&
      detail.draft.version !== version &&
      $("comment").value
    ) {
      $("status").textContent = "A new version is available. Finish your comment, then refresh.";
      renderComments();
      return;
    }
    const desired = Number(params.get("version")) || detail.draft.version;
    const changed = version !== desired;
    version = desired;
    $("title").textContent = detail.draft.title;
    $("updated").textContent =
      `${detail.draft.kind} · ${date(detail.draft.updatedAt)}`;
    $("versions").replaceChildren(
      ...detail.versions.map((v) => {
        const o = node("option", `v${v.version} · ${date(v.createdAt)}`);
        o.value = v.version;
        return o;
      }),
    );
    $("versions").value = String(version);
    for (const k of ["versions", "download", "share", "toggleFeedback", "canvas"])
      $(k).hidden = false;
    setFeedbackOpen(feedbackOpen);
    $("empty").hidden = true;
    $("download").href =
      `/api/drafts/content?id=${id}&version=${version}&download=1`;
    if (changed || !preserveFrame) {
      frameReady = false;
      anchor = null;
      $("canvas").src = `/api/drafts/content?id=${id}&version=${version}`;
    }
    syncCommentForm();
    renderComments();
    $("status").textContent =
      version !== detail.draft.version
        ? "Viewing an earlier version. Comments will refer to this version."
        : "";
  } catch (e) {
    if (current === generation && !signal.aborted)
      $("status").textContent = e.message;
  } finally {
    if (current === generation) $("refresh").disabled = false;
  }
}
async function action(fn) {
  if (busy) return;
  busy = true;
  syncCommentForm();
  syncReviewActions();
  try {
    await fn();
  } catch (e) {
    $("status").textContent = e.message;
    $("feedbackStatus").textContent = e.message;
  } finally {
    busy = false;
    syncCommentForm();
    syncReviewActions();
  }
}
window.addEventListener("message", (event) => {
  if (
    event.source !== $("canvas").contentWindow ||
    event.data?.source !== "tmax-draft"
  )
    return;
  const msg = event.data;
  if (msg.type === "ready") {
    frameReady = true;
    sendComments();
  }
  if (
    msg.type === "selection" &&
    typeof msg.anchor?.quote === "string" &&
    msg.anchor.quote.trim() &&
    msg.anchor.quote.length <= 12000
  ) {
    anchor = msg.anchor;
    syncCommentForm();
    if (!feedbackOpen) setFeedbackOpen(true, { reveal: true });
  }
  if (msg.type === "anchors" && Array.isArray(msg.states))
    for (const state of msg.states) {
      const item = [...$("comments").children].find(
        (x) => x.dataset.commentId === state.id,
      );
      const status = item?.querySelector(".anchor-status");
      if (status)
        status.textContent =
          state.status === "found"
            ? "Click to find quoted text"
            : state.status === "ambiguous"
              ? "Quote appears more than once"
              : "Text has changed; original quote retained";
    }
});
$("commentForm").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    if (!version || !$("comment").value.trim()) return;
    const savedAnchor = anchor,
      text = $("comment").value;
    $("saveComment").disabled = true;
    try {
      await request(`/api/drafts/comments?id=${id}`, {
        method: "POST",
        body: JSON.stringify({ version, anchor: savedAnchor, text }),
      });
      if ($("comment").value === text) {
        $("comment").value = "";
        if (anchor === savedAnchor) {
          anchor = null;
          postFrame({ type: "clear-selection" });
        }
      }
      $("feedbackStatus").textContent = "Comment saved.";
      await reloadDetail();
    } finally {
      syncCommentForm();
    }
  });
};
$("comment").addEventListener("input", syncCommentForm);
$("toggleFeedback").onclick = () => setFeedbackOpen(!feedbackOpen, { reveal: true });
$("clearSelection").onclick = () => {
  anchor = null;
  postFrame({ type: "clear-selection" });
  syncCommentForm();
  $("comment").focus();
};
async function prompt(send, create = false) {
  const body = create
    ? {
        ...context,
        filename: $("filename").value,
        request: $("request").value,
        send,
      }
    : { send };
  const data = await request(`/api/drafts/prompt${create ? "" : `?id=${id}`}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!send) await navigator.clipboard.writeText(data.prompt);
  const text = send
    ? "Sent to Agent. Refresh when the draft is ready."
    : "Instructions copied.";
  $("status").textContent = text;
  $("feedbackStatus").textContent = text;
}
$("revise").onclick = () => {
  if ($("revise").disabled) return;
  action(async () => {
    reviseState = "sending";
    syncReviewActions();
    $("feedbackStatus").textContent = "Sending feedback to Agent…";
    try {
      await prompt(true);
      reviseState = "sent";
      reviseReset = setTimeout(() => {
        reviseState = "idle";
        syncReviewActions();
      }, 1800);
    } catch (error) {
      reviseState = "idle";
      throw error;
    }
  });
};
$("copyFeedback").onclick = () => action(() => prompt(false));
$("createForm").onsubmit = (e) => {
  e.preventDefault();
  action(() => prompt(true, true));
};
$("copyCreate").onclick = () => action(() => prompt(false, true));
$("share").onclick = () => setSharingOpen($("sharePanel").hidden);
$("closeShare").onclick = () => setSharingOpen(false);
$("sharePanel").onkeydown = (event) => {
  if (event.key === "Escape") setSharingOpen(false);
};
$("publicLink").onclick = () => $("publicLink").select();
async function copyShareLink(isPublic) {
  const link = isPublic ? $("publicLink").value : `${location.origin}/drafts?id=${id}`;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    $("shareStatus").textContent = isPublic ? "Public link copied. Anyone with this link can open it." : "Private link copied. Sign-in and session access are required.";
  } catch {
    $("shareStatus").textContent = isPublic ? "Could not copy. Select the public link above and copy it." : "Could not copy the link. Try again.";
    if (isPublic) { $("publicLink").focus(); $("publicLink").select(); }
  }
}
$("copyPrivateLink").onclick = () => copyShareLink(false);
$("copyPublicLink").onclick = () => copyShareLink(true);
$("togglePublicSharing").onclick = async () => {
  if (sharingBusy || !detail?.sharing?.canManage) return;
  sharingBusy = true;
  const enabled = !detail.sharing.enabled;
  renderSharing();
  $("shareStatus").textContent = enabled ? "Enabling public link…" : "Disabling public link…";
  try {
    const result = await request(`/api/drafts/sharing?id=${id}`, {
      method: "PUT", body: JSON.stringify({ enabled }),
    });
    detail.sharing = result.sharing;
    $("shareStatus").textContent = enabled ? "Public link enabled. Copy the link to share this draft."
      : "Public link disabled. The old link no longer opens this draft.";
  } catch (error) {
    $("shareStatus").textContent = error.message;
  } finally {
    sharingBusy = false;
    renderSharing();
  }
};
$("versions").onchange = () => {
  if ($("comment").value) {
    $("status").textContent = "Save your comment before switching versions.";
    $("versions").value = version;
    return;
  }
  params.set("version", $("versions").value);
  load();
};
$("refresh").onclick = () => {
  params.delete("version");
  load({ preserveFrame: true });
};
window.addEventListener("pagehide", () => {
  rememberLibraryPosition();
  try { sessionStorage.setItem(libraryScrollKey, String(libraryScrollTop)); } catch {}
  ++generation;
  controller?.abort();
  clearTimeout(reviseReset);
  if (reviseState === "sent") reviseState = "idle";
  syncReviewActions();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !busy) load({ preserveFrame: true });
});
if (context.machineId && context.sessionId) {
  $("createPanel").hidden = false;
  $("scope").textContent = `Drafts for this ${context.kind} session`;
  $("emptyHint").textContent = "Open New draft on the left and tell the Agent what to create.";
}
syncInputWakeLock();
syncReviewActions();
load();

// Draft forms inside the Vision Pro app use explicit voice/clear buttons.
if (isVisionDevice()) {
  let activeField = null;
  let activeDictation = null;
  cancelVisionDictation = () => activeDictation?.cancel();
  for (const form of document.querySelectorAll("form")) {
    form.noValidate = true;
    form.addEventListener("submit", event => {
      if (activeField && form.contains(activeField)) {
        event.preventDefault(); event.stopImmediatePropagation();
        void activeDictation.submit(async () => { form.requestSubmit(event.submitter); });
        return;
      }
      const invalid = Array.from(form.elements).find(field => field.willValidate && !field.checkValidity());
      if (invalid) {
        event.preventDefault(); event.stopImmediatePropagation();
        $("status").textContent = invalid.validationMessage;
      }
    }, true);
  }
  for (const input of document.querySelectorAll('textarea, input:not([type]), input[type="text"]')) {
    const preview = visionTextPreview(input);
    if (!preview || input.readOnly) continue;
    const controls = document.createElement('div');
    const voice = document.createElement('button');
    const clear = document.createElement('button');
    const status = document.createElement('span');
    voice.type = clear.type = 'button';
    clear.textContent = 'Clear';
    status.setAttribute('role', 'status');
    controls.append(voice, clear, status);
    preview.after(controls);
    const change = text => { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); };
    const dictation = bindStreamingDictation({
      button: voice, input, controls: [clear],
      getText: () => input.value, setText: change,
      setStatus: text => { status.textContent = text; },
      isBlocked: () => input.disabled || (activeField && activeField !== input),
      onActive: active => { activeField = active ? input : null; activeDictation = active ? dictation : null; },
    });
    clear.onclick = () => { if (!dictation.active) change(''); };
  }
}
