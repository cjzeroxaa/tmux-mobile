export async function showTerminalShareDialog(call, copyText) {
  if (document.querySelector("#terminal-share-dialog")) return;
  const dialog = document.createElement("dialog");
  dialog.id = "terminal-share-dialog";
  dialog.className = "cc-share-dialog";
  dialog.innerHTML = `<form method="dialog"><h2>Share terminal</h2><button class="cc-share-close" aria-label="Close">×</button></form>
    <p>Anyone with the link can view this terminal. The link expires after 24 hours, or you can stop sharing earlier.</p>
    <label><input type="checkbox" data-share-control> Allow viewers to type and run commands</label>
    <p data-share-status role="status">Loading…</p>
    <input data-share-url aria-label="Share link" readonly hidden>
    <div class="cc-share-actions"><button type="button" data-share-create disabled>Create link</button><button type="button" data-share-copy hidden>Copy link</button><a data-share-open target="_blank" rel="noopener noreferrer" hidden>Open</a><button type="button" data-share-stop hidden>Stop sharing</button></div>`;
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
  const status = dialog.querySelector("[data-share-status]");
  const checkbox = dialog.querySelector("[data-share-control]");
  const url = dialog.querySelector("[data-share-url]");
  const create = dialog.querySelector("[data-share-create]");
  const copy = dialog.querySelector("[data-share-copy]");
  const open = dialog.querySelector("[data-share-open]");
  const stop = dialog.querySelector("[data-share-stop]");
  let busy = false;
  const request = action => call({ action, allowControl: checkbox.checked });
  const render = data => {
    const active = Boolean(data.viewerUrl);
    checkbox.checked = Boolean(data.allowControl);
    checkbox.disabled = active;
    create.hidden = active;
    url.hidden = copy.hidden = open.hidden = stop.hidden = !active;
    url.value = data.viewerUrl || "";
    open.href = data.viewerUrl || "#";
    status.textContent = active ? `Sharing ${data.allowControl ? "with control" : "view only"}. Expires ${new Date(data.expiresAt).toLocaleString()}.` : "Ready to create a view-only link.";
  };
  const run = async action => {
    if (busy) return;
    busy = true; create.disabled = stop.disabled = true;
    status.textContent = action === "start" ? "Creating share…" : action === "stop" ? "Stopping share…" : "Loading…";
    try { render(await request(action)); } catch (error) { status.textContent = error.message; }
    finally { busy = false; create.disabled = stop.disabled = false; }
  };
  create.onclick = () => run("start");
  stop.onclick = () => run("stop");
  copy.onclick = async () => {
    try { await copyText(url.value); status.textContent = "Link copied."; }
    catch { url.focus(); url.select(); status.textContent = "Select and copy this link."; }
  };
  await run("status");
}

