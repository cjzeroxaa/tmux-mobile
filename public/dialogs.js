// App-owned dialogs: no browser alerts, and no blocking the page's event loop.
const style = document.createElement('link');
style.rel = 'stylesheet';
style.href = new URL('./dialogs.css', import.meta.url).href;
document.head.append(style);
let active = null;

function showDialog({ title, message = '', input, confirmLabel = 'Confirm', danger = false }) {
  // A second click must not queue another destructive operation behind this one.
  if (active) return Promise.resolve(null);
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    active = dialog;
    dialog.className = 'tmax-dialog';
    dialog.setAttribute('aria-labelledby', 'tmax-dialog-title');
    dialog.setAttribute('aria-describedby', 'tmax-dialog-message');
    dialog.innerHTML = `<form><h2 id="tmax-dialog-title"></h2><p id="tmax-dialog-message"></p><label class="tmax-dialog-label" hidden><span></span><input type="text" autocomplete="off"></label><div class="tmax-dialog-actions"><button type="button" data-cancel>Cancel</button><button type="submit" data-confirm></button></div></form>`;
    dialog.querySelector('h2').textContent = title;
    const description = dialog.querySelector('p');
    description.textContent = message; description.hidden = !message;
    const field = dialog.querySelector('input');
    const cancel = dialog.querySelector('[data-cancel]');
    const confirm = dialog.querySelector('[data-confirm]');
    confirm.textContent = confirmLabel;
    confirm.classList.toggle('is-danger', danger);
    if (input) {
      dialog.querySelector('label').hidden = false;
      dialog.querySelector('label span').textContent = input.label || title;
      field.value = input.value || '';
      field.readOnly = Boolean(input.readOnly);
    }
    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      window.removeEventListener('popstate', dismiss);
      window.removeEventListener('pagehide', dismiss);
      dialog.close(); dialog.remove(); active = null;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(value);
    }
    const dismiss = () => finish(null);
    dialog.querySelector('form').addEventListener('submit', event => {
      event.preventDefault(); finish(input ? field.value : true);
    });
    cancel.addEventListener('click', dismiss);
    dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
    dialog.addEventListener('close', dismiss);
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dismiss();
    });
    window.addEventListener('popstate', dismiss);
    window.addEventListener('pagehide', dismiss);
    document.body.append(dialog);
    dialog.showModal();
    // Default to Cancel for destructive actions; select existing names for editing.
    if (input) { field.focus(); field.select(); }
    else cancel.focus();
  });
}
export async function confirmAction(options) { return (await showDialog(options)) === true; }
export function promptValue({ value = '', label, readOnly = false, ...options }) {
  return showDialog({ confirmLabel: readOnly ? 'Done' : 'Save', ...options, input: { value, label, readOnly } });
}
