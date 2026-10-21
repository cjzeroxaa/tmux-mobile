export async function showTerminalShareDialog(call, copyText) {
  if (document.querySelector("#terminal-share-dialog")) return;
  const dialog = document.createElement("dialog");
  dialog.id = "terminal-share-dialog";
  dialog.className = "cc-share-dialog";
  dialog.innerHTML = `<form method="dialog"><h2>Share terminal</h2><button class="cc-share-close" aria-label="Close">×</button></form>
    <p>Anyone with the link can view this terminal. Choose when the link expires, or stop sharing earlier.</p>
    <label class="cc-share-duration">Expires after <select data-share-duration><option value="600">10 minutes</option><option value="86400" selected>24 hours</option><option value="432000">5 days</option><option value="604800">7 days</option></select></label>
    <label><input type="checkbox" data-share-control checked> Allow viewers to type and run commands</label>
    <p data-share-status role="status">Loading…</p>
    <input data-share-url aria-label="Share link" readonly hidden>
    <div class="cc-share-actions"><button type="button" data-share-create disabled>Create link</button><button type="button" data-share-copy hidden>Copy link</button><a data-share-open target="_blank" rel="noopener noreferrer" hidden>Open</a><button type="button" data-share-stop hidden>Stop sharing</button></div>`;
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
  const status = dialog.querySelector("[data-share-status]");
  const duration = dialog.querySelector("[data-share-duration]");
  const checkbox = dialog.querySelector("[data-share-control]");
  const url = dialog.querySelector("[data-share-url]");
  const create = dialog.querySelector("[data-share-create]");
  const copy = dialog.querySelector("[data-share-copy]");
  const open = dialog.querySelector("[data-share-open]");
  const stop = dialog.querySelector("[data-share-stop]");
  let busy = false;
  const request = action => call({ action, allowControl: checkbox.checked, ttlSeconds: Number(duration.value) });
  const render = data => {
    const active = Boolean(data.viewerUrl);
    checkbox.checked = active ? Boolean(data.allowControl) : true;
    checkbox.disabled = active;
    duration.disabled = active;
    if (active) {
      const value = String(data.ttlSeconds || 86400);
      if (![...duration.options].some(option => option.value === value)) duration.add(new Option(`${Math.ceil(Number(value) / 60)} minutes`, value));
      duration.value = value;
    } else if (!["600", "86400", "432000", "604800"].includes(duration.value)) duration.value = "86400";
    create.hidden = active;
    url.hidden = copy.hidden = open.hidden = stop.hidden = !active;
    url.value = data.viewerUrl || "";
    open.href = data.viewerUrl || "#";
    status.textContent = active ? `Sharing ${data.allowControl ? "with control" : "view only"}. Expires ${new Date(data.expiresAt).toLocaleString()}.` : "Ready to share. Input turns on automatically; uncheck to make the link view-only.";
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
