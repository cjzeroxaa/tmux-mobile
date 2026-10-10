const $ = id => document.getElementById(id);
let canEdit = false;
let saved;
async function request(options) {
  const response = await fetch('/api/notification-settings', { cache: 'no-store', ...options });
  if (response.status === 401) {
    $('login').hidden = false;
    canEdit = false;
    throw new Error('Sign in to manage notifications.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not save notification settings.');
  return data;
}
function apply(data) {
  saved = data.settings;
  canEdit = data.canEdit;
  $('enabled').checked = saved.enabled;
  $('start').value = saved.start;
  $('end').value = saved.end;
  $('timeZone').value = saved.updatedAt ? saved.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('permission').textContent = canEdit ? '' : 'Only an administrator can change these shared settings.';
  $('save').hidden = !canEdit;
  updateControls();
}
function updateControls() {
  $('controls').disabled = !canEdit;
  $('schedule').disabled = !$('enabled').checked;
}
async function load() {
  $('retry').hidden = true;
  $('controls').disabled = true;
  $('status').textContent = 'Loading…';
  try { apply(await request()); $('status').textContent = ''; }
  catch (error) { $('status').textContent = error.message; $('retry').hidden = false; }
}
$('enabled').addEventListener('change', updateControls);
$('device-zone').addEventListener('click', () => { $('timeZone').value = Intl.DateTimeFormat().resolvedOptions().timeZone; });
$('retry').addEventListener('click', load);
$('settings').addEventListener('submit', async event => {
  event.preventDefault();
  if (!canEdit || $('controls').disabled) return;
  const enabled = $('enabled').checked;
  const settings = enabled ? { enabled, start: $('start').value, end: $('end').value, timeZone: $('timeZone').value.trim() } : { ...saved, enabled: false };
  $('controls').disabled = true;
  $('status').textContent = 'Saving…';
  try { apply(await request({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) })); $('status').textContent = 'Saved. The server is using these settings now.'; }
  catch (error) { $('status').textContent = error.message; }
  finally { updateControls(); }
});
for (const zone of Intl.supportedValuesOf?.('timeZone') || []) {
  const option = document.createElement('option'); option.value = zone; $('zones').append(option);
}
void load();
