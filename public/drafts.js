import { syncInputWakeLock } from "./screen-awake.mjs";
const $ = (id) => document.getElementById(id),
  params = new URLSearchParams(location.search);
const context = {
  machineId: params.get("machineId") || "",
  kind: params.get("kind") || "",
  sessionId: params.get("sessionId") || "",
};
let id = params.get("id") || "",
  detail = null,
  version = 0,
  anchor = null,
  generation = 0,
  controller,
  frameReady = false;
let busy = false;
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
    const quote = node("blockquote", c.anchor.quote);
    quote.tabIndex = 0;
    quote.title = "Find quoted text";
    quote.onclick = () => postFrame({ type: "focus", id: c.id });
    quote.onkeydown = (e) => {
      if (e.key === "Enter") quote.click();
    };
    item.append(
      quote,
      node("span", "Locating…", "anchor-status"),
      node("p", c.text),
    );
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
    $("comments").append(node("p", "No comments yet. Select text in the draft to begin."));
  $("revise").disabled = !detail.comments.some((c) => c.status === "open");
  $("copyFeedback").disabled = $("revise").disabled;
  sendComments();
}
async function reloadDetail() {
  detail = await request(`/api/drafts?id=${id}`);
  renderComments();
}
async function load({ preserveFrame = false } = {}) {
  const current = ++generation;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  $("refresh").disabled = true;
  $("status").textContent = "Loading…";
  try {
    const [list, selected] = await Promise.all([
      request(`/api/drafts?${query()}`, { signal }),
      id ? request(`/api/drafts?id=${id}`, { signal }) : null,
    ]);
    if (current !== generation) return;
    $("draftList").replaceChildren();
    for (const d of list.drafts) {
      const a = node("a", undefined, "draft-link");
      a.href = `/drafts?${query({ id: d.id })}`;
      a.setAttribute("aria-current", String(d.id === id));
      a.append(
        node("strong", d.title),
        node("small", `${d.kind} · v${d.version} · ${date(d.updatedAt)}`),
      );
      $("draftList").append(a);
    }
    if (!selected) {
      $("empty").hidden = false;
      $("status").textContent = list.drafts.length
        ? ""
        : context.sessionId
          ? "No drafts for this session yet."
          : "No drafts yet.";
      return;
    }
    detail = selected;
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
    for (const k of ["versions", "download", "share", "feedback", "canvas"])
      $(k).hidden = false;
    $("empty").hidden = true;
    $("download").href =
      `/api/drafts/content?id=${id}&version=${version}&download=1`;
    if (changed || !preserveFrame) {
      frameReady = false;
      anchor = null;
      $("selection").textContent = "No text selected";
      $("saveComment").disabled = true;
      $("canvas").src = `/api/drafts/content?id=${id}&version=${version}`;
    }
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
  try {
    await fn();
  } catch (e) {
    $("status").textContent = e.message;
    $("feedbackStatus").textContent = e.message;
  } finally {
    busy = false;
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
    msg.anchor.quote.length <= 12000
  ) {
    anchor = msg.anchor;
    $("selection").textContent = anchor.quote;
    $("saveComment").disabled = false;
  }
  if (msg.type === "anchors" && Array.isArray(msg.states))
    for (const state of msg.states) {
      const item = [...$("comments").children].find(
        (x) => x.dataset.commentId === state.id,
      );
      if (item)
        item.querySelector(".anchor-status").textContent =
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
    if (!anchor) return;
    const savedAnchor = anchor,
      text = $("comment").value;
    $("saveComment").disabled = true;
    try {
      await request(`/api/drafts/comments?id=${id}`, {
        method: "POST",
        body: JSON.stringify({ version, anchor: savedAnchor, text }),
      });
      if ($("comment").value === text) $("comment").value = "";
      $("feedbackStatus").textContent = "Comment saved.";
      await reloadDetail();
    } finally {
      $("saveComment").disabled = !anchor;
    }
  });
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
$("revise").onclick = () => action(() => prompt(true));
$("copyFeedback").onclick = () => action(() => prompt(false));
$("createForm").onsubmit = (e) => {
  e.preventDefault();
  action(() => prompt(true, true));
};
$("copyCreate").onclick = () => action(() => prompt(false, true));
$("share").onclick = () =>
  action(async () => {
    await navigator.clipboard.writeText(`${location.origin}/drafts?id=${id}`);
    $("status").textContent = "Link copied. Access requires permission to this session.";
  });
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
  ++generation;
  controller?.abort();
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
load();
