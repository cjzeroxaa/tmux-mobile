const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
let kind = params.get('kind') === 'daily' ? 'daily' : 'hourly';
let ids = [], nextBefore = null, generation = 0, controller;
const date = (value, options = {}) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', ...options }).format(new Date(value));
const idTime = id => { const [, y, m, d, h] = /-(\d{4})(\d{2})(\d{2})T(\d{2})$/.exec(id) || []; return `${y}-${m}-${d}T${h}:00:00Z`; };
function label(id) { return date(idTime(id), id.startsWith('hourly-') ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : { year: 'numeric' }); }
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function render(report) {
  const root = $('report'); root.replaceChildren();
  const header = node('header', undefined, 'report-head');
  header.append(node('span', report.kind === 'daily' ? 'DAILY REPORT' : 'HOURLY REPORT', 'eyebrow'));
  header.append(node('h2', date(report.start, { year: 'numeric' })));
  const range = report.kind === 'hourly' ? `${date(report.start, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} — ${date(report.end, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}` : '全天';
  header.append(node('p', `${range} · 北京时间 · ${report.sessions.length} 个 Session 有进展`)); root.append(header);
  if (report.status === 'failed') { root.append(node('p', report.attempts >= 3 ? '这份汇报暂时生成失败，已停止重试。其他时段的汇报会继续生成。' : '这份汇报暂时生成失败，服务端稍后会重试。', 'notice')); return; }
  if (report.partial) root.append(node('p', '本时段记录可能不完整（服务刚开始收集、同步延迟或记录量较大）；以下仅汇总已收到的内容。', 'notice'));
  if (!report.sessions.length) { const empty = node('section', undefined, 'empty'); empty.append(node('h2', '这一时段，暂无明显进展'), node('p', '在你可查看的会话记录中，没有需要汇报的新进展。')); root.append(empty); return; }
  const machines = new Map();
  for (const session of report.sessions) {
    if (!machines.has(session.machineId)) { const section = node('section', undefined, 'machine'); section.append(node('h3', session.machineName)); machines.set(session.machineId, section); root.append(section); }
    const section = node('section', undefined, 'session'); const title = node('h4');
    const link = node('a', session.sessionName || session.sessionId);
    link.href = `/conversation?${new URLSearchParams({ machineId: session.machineId, kind: session.kind, sessionId: session.sessionId })}`;
    title.append(link, node('span', session.kind, 'kind')); section.append(title);
    const list = node('ul'); for (const bullet of session.bullets) list.append(node('li', bullet)); section.append(list); machines.get(session.machineId).append(section);
  }
}
async function request(query, signal) {
  const response = await fetch(`/api/reports?${query}`, { cache: 'no-store', signal });
  if (response.status === 401) { $('login').hidden = false; $('login').href = `/auth/google/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`; }
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '汇报加载失败，请重试。'); return data;
}
async function load({ append = false, selected = '', onlyReport = false } = {}) {
  const current = ++generation; controller?.abort(); controller = new AbortController(); const signal = controller.signal;
  const timeout = setTimeout(() => controller?.signal === signal && controller.abort(), 30_000);
  $('refresh').disabled = true; document.querySelector('.reader').setAttribute('aria-busy', 'true'); $('status').textContent = '正在读取汇报…'; $('login').hidden = true;
  $('report').replaceChildren();
  try {
    if (!onlyReport) {
      const data = await request(new URLSearchParams({ kind, ...(append && nextBefore ? { before: nextBefore } : {}) }), signal);
      if (current !== generation) return;
      ids = append ? [...new Set([...ids, ...data.ids])] : data.ids; nextBefore = data.nextBefore;
      $('reportPicker').replaceChildren(...ids.map(id => { const option = node('option', label(id)); option.value = id; return option; }));
      $('older').hidden = !nextBefore;
      $('schedule').textContent = `下一份${kind === 'hourly' ? '小时报' : '日报'}：${date(kind === 'hourly' ? data.nextHourlyAt : data.nextDailyAt, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
      if (data.error) $('schedule').textContent += ' · 服务暂时遇到问题，将自动重试';
    }
    const id = selected || ids[0];
    if (!id) { $('status').textContent = kind === 'daily' ? '日报将在每天凌晨汇总前一天的小时报。' : '已经开始收集进展，首份小时报将在整点后生成。'; return; }
    if (!ids.includes(id)) { const option = node('option', label(id)); option.value = id; $('reportPicker').append(option); }
    $('reportPicker').value = id;
    const data = await request(new URLSearchParams({ id }), signal); if (current !== generation) return;
    render(data.result); $('status').textContent = '';
    history.replaceState(null, '', `/reports?${new URLSearchParams({ kind, id })}`);
  } catch (error) { if (current === generation) $('status').textContent = signal.aborted ? '读取超时，请刷新重试。' : error.message; }
  finally { clearTimeout(timeout); if (current === generation) { $('refresh').disabled = false; document.querySelector('.reader').setAttribute('aria-busy', 'false'); } }
}
function selectKind(value) { kind = value; for (const k of ['hourly', 'daily']) $(k).setAttribute('aria-pressed', String(k === kind)); load(); }
$('hourly').addEventListener('click', () => selectKind('hourly')); $('daily').addEventListener('click', () => selectKind('daily'));
$('refresh').addEventListener('click', () => load()); $('reportPicker').addEventListener('change', () => load({ selected: $('reportPicker').value, onlyReport: true }));
$('older').addEventListener('click', () => load({ append: true, selected: $('reportPicker').value }));
window.addEventListener('pagehide', () => { ++generation; controller?.abort(); });
for (const k of ['hourly', 'daily']) $(k).setAttribute('aria-pressed', String(k === kind));
const initialId = params.get('id');
load({ selected: /^(hourly|daily)-\d{8}T\d{2}$/.test(initialId || '') ? initialId : '' });
// No polling. Opening, choosing a period, or pressing Refresh are the only reads.
