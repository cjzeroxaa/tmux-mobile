const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
let busy = false, current = null, share = null, pendingCreateId = null, generation = 0;
let tick = null;
const machineName = () => $('machine').selectedOptions[0]?.textContent || 'Shell';
function setBusy(value) {
  busy = value;
  document.querySelectorAll('button,select').forEach(el => { el.disabled = value; });
  if (!value) $('create').disabled = !$('machine').value;
}
async function api(method = 'GET', body) {
  const response = await fetch('/api/temporary-terminals', {
    method, signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/json', 'x-machine-id': $('machine').value, 'x-mux': 'tmux' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401 || response.redirected) throw new Error('Sign in again to manage this terminal. Reload this page.');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function detach() {
  clearInterval(tick); tick = null;
  $('terminal').removeAttribute('src'); $('terminal').hidden = true;
}
function countdown() {
  const seconds = Math.max(0, Math.ceil(((share?.expiresAt || 0) - Date.now()) / 1000));
  $('remaining').textContent = seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left` : 'Sharing ended';
  $('stop').hidden = !seconds;
  $('reopen').hidden = Boolean(seconds);
  $('extend').hidden = !seconds;
  $('paused').hidden = Boolean(seconds);
  if (!seconds) detach();
}
function show(result) {
  const oldUrl = share?.viewerUrl;
  current = result.terminal; share = result.share;
  $('workspace').hidden = !current; $('chooser').hidden = Boolean(current);
  document.body.classList.toggle('has-terminal', Boolean(current));
  if (!current) { detach(); return; }
  $('terminalName').textContent = `${machineName()} · ${current.id.slice(0, 8)}`;
  if (share?.viewerUrl && share.expiresAt > Date.now()) {
    const url = new URL(share.viewerUrl);
    if (url.origin !== 'https://share.xyznot.com') throw new Error('Unexpected sharing address');
    if (oldUrl !== share.viewerUrl || !$('terminal').getAttribute('src')) $('terminal').src = url.href;
    $('terminal').hidden = false;
  } else detach();
  clearInterval(tick); tick = setInterval(countdown, 1000); countdown();
}
async function refresh() {
  if (busy) return;
  const run = ++generation;
  setBusy(true); $('status').textContent = 'Loading terminals…';
  try {
    const data = await api();
    if (run !== generation) return;
    $('terminals').replaceChildren();
    for (const terminal of data.terminals) {
      const row = document.createElement('li'), open = document.createElement('button'), label = document.createElement('span');
      open.textContent = `Open ${terminal.id.slice(0, 8)}`;
      open.onclick = () => act('open', terminal.id);
      label.textContent = `${new Date(terminal.createdAt).toLocaleString()} · ${terminal.command || 'shell'}`;
      row.append(open, label); $('terminals').append(row);
    }
    $('status').textContent = data.terminals.length ? 'Existing shells are preserved until you close them.' : 'No temporary terminals on this machine.';
  } catch (error) { $('status').textContent = error.message; }
  finally { if (run === generation) setBusy(false); }
}
async function act(action, id = current?.id) {
  if (busy) return;
  if (action === 'close' && !confirm(`Close temporary terminal ${id.slice(0, 8)} on ${machineName()}? This ends its running commands.`)) return;
  setBusy(true); $('status').textContent = action === 'create' ? 'Starting shell…' : 'Updating terminal…';
  try {
    const result = await api('POST', { action, id });
    if (action === 'create') pendingCreateId = null;
    show(result);
    $('status').textContent = result.share ? 'Take control in the terminal to type. Expiry stops sharing only.' : result.terminal ? 'Sharing stopped. Your shell is still running.' : 'Terminal closed.';
  } catch (error) { $('status').textContent = error.message; }
  finally { setBusy(false); }
  if (action === 'close' && !current) await refresh();
}
$('create').onclick = () => { pendingCreateId ||= crypto.randomUUID(); void act('create', pendingCreateId); };
$('refresh').onclick = refresh;
$('machine').onchange = () => { pendingCreateId = null; show({ terminal: null, share: null }); void refresh(); };
$('extend').onclick = () => act('extend');
$('reopen').onclick = () => act('open');
$('stop').onclick = () => act('stop');
$('close').onclick = () => act('close');
$('back').onclick = () => { show({ terminal: null, share: null }); void refresh(); };
window.addEventListener('pagehide', detach);
window.addEventListener('pageshow', event => { if (event.persisted && current) show({ terminal: current, share }); });
// The only timer is a local countdown. No background HTTP polling.
try {
  const response = await fetch('/api/machines', { signal: AbortSignal.timeout(15000) });
  if (!response.ok || response.redirected) throw new Error('Sign in again, then reload this page.');
  const machines = await response.json();
  for (const machine of machines) {
    const id = machine.id || machine.machineId;
    $('machine').add(new Option(machine.hostname || machine.machineId || id, id));
  }
  if (machines.some(machine => (machine.id || machine.machineId) === params.get('machineId'))) $('machine').value = params.get('machineId');
  if (!machines.length) throw new Error('No connected machines.');
  await refresh();
} catch (error) { $('status').textContent = error.message; }
