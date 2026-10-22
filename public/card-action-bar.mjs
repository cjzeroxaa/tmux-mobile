import { CARD_ACTIONS, CARD_ACTION_COLUMNS, CARD_ACTION_ICONS } from "./card-actions.js";

const escape = (value) => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function cardActionIcon(id) {
  const nodes = CARD_ACTION_ICONS[id].map(([tag, attrs]) =>
    `<${tag} ${Object.entries(attrs).map(([key, value]) => `${key}="${escape(value)}"`).join(" ")}/>`).join("");
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${nodes}</svg>`;
}

// Render every slot, including unavailable actions: capability changes must not
// move a different action underneath the user's finger.
export function renderCardActionBar(states) {
  return `<div class="cc-card-actions" role="group" aria-label="Session actions" style="--card-action-columns:${CARD_ACTION_COLUMNS}">${CARD_ACTIONS.map(action => {
    const state = states[action.id];
    const disabled = !state || Boolean(state.disabled);
    const label = state?.label || action.label;
    const title = `${label}${state?.shortcut ? ` (${state.shortcut})` : ""} · ${action.hint}`;
    const attrs = Object.entries(state?.attributes || {}).map(([key, value]) => `${key}="${escape(value)}"`).join(" ");
    const shared = `class="cc-card-action cc-${action.id}-button${action.id === "terminal" ? " cc-open-button" : ""}${state?.active ? " is-reading" : ""}${state?.busy ? " is-busy" : ""}" data-card-action="${action.id}" title="${escape(title)}" aria-label="${escape(label)}"${state?.busy ? ' aria-busy="true"' : ""}`;
    const icon = cardActionIcon(state?.icon || action.id);
    if (state?.href && !disabled) return `<a ${shared} href="${escape(state.href)}" target="_blank" rel="noopener noreferrer">${icon}</a>`;
    return `<button ${shared} type="button"${disabled ? " disabled" : ""} ${attrs}>${icon}</button>`;
  }).join("")}</div>`;
}
