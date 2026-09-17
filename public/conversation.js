import { renderMarkdown } from './markdown.js';
import { addMermaidButtons } from './mermaid-diagrams.mjs';
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const query = new URLSearchParams(['machineId', 'kind', 'sessionId'].map(key => [key, params.get(key) || '']));
const shareUrl = `${location.origin}/conversation?${query}`;
let loading = false;
let turns = [];
let start = 0;
function renderMessages() {
  const fragment = document.createDocumentFragment();
  for (const turn of turns.slice(start)) {
    const article = document.createElement('article');
    article.className = `message ${turn.role}`;
    const header = document.createElement('header');
    const label = document.createElement('strong');
    label.textContent = turn.role === 'user' ? 'User' : params.get('kind') === 'claude' ? 'Claude' : 'Codex';
    header.append(label);
    if (turn.t && Number.isFinite(Date.parse(turn.t))) {
      const time = document.createElement('time'); time.dateTime = turn.t;
      time.textContent = new Date(turn.t).toLocaleString(); header.append(time);
    }
    const body = document.createElement('div'); body.className = 'message-body';
    if (turn.role === 'user') body.textContent = turn.text;
    else {
      const template = document.createElement('template');
      template.innerHTML = renderMarkdown(turn.text);
      // Records are passive content. Do not auto-download embedded remote images.
      for (const image of template.content.querySelectorAll('img')) {
        const link = document.createElement('a'); link.textContent = image.alt || 'Open image';
        const url = new URL(image.getAttribute('src'), location.origin);
        if (['http:', 'https:'].includes(url.protocol)) { link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
        image.replaceWith(link);
      }
      for (const link of template.content.querySelectorAll('a')) {
        const url = new URL(link.getAttribute('href') || '', location.origin);
        if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) link.removeAttribute('href');
        link.rel = 'noopener noreferrer';
      }
      body.append(template.content);
      addMermaidButtons(body);
    }
    article.append(header, body); fragment.append(article);
  }
  $('messages').replaceChildren(fragment);
  $('more').hidden = start === 0;
  $('more').textContent = `Show earlier messages (${start} remaining)`;
}
async function load() {
  if (loading) return;
  loading = true; $('refresh').disabled = true; $('status').textContent = 'Loading conversation…'; $('login').hidden = true;
  try {
    const response = await fetch(`/api/conversation?${query}`, { cache: 'no-store' });
    if (response.status === 401) {
      $('login').href = `/auth/google/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
      $('login').hidden = false;
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load conversation.');
    turns = data.result.turns; start = Math.max(0, turns.length - 100);
    $('meta').textContent = `${data.result.kind === 'claude' ? 'Claude' : 'Codex'} · ${turns.length} messages · Synced ${new Date(data.result.updatedAt).toLocaleString()}`;
    $('status').textContent = turns.length ? '' : 'No user messages or final replies have been archived yet.';
    renderMessages();
  } catch (error) {
    turns = []; $('messages').replaceChildren(); $('more').hidden = true;
    $('status').textContent = error.message;
  } finally { loading = false; $('refresh').disabled = false; }
}
$('refresh').addEventListener('click', load);
$('more').addEventListener('click', () => { const oldHeight = document.documentElement.scrollHeight; start = Math.max(0, start - 100); renderMessages(); window.scrollBy(0, document.documentElement.scrollHeight - oldHeight); });
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(shareUrl); $('status').textContent = 'Link copied. Session permissions still apply.'; }
  catch { $('status').textContent = 'Copy the address from your browser to share this conversation.'; }
});
load();
