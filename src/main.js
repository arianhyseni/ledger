/* ---------------------------------------------------------
   app.js — shell: state, boot, navigation
--------------------------------------------------------- */

import './styles/app.css';
import qrcode from 'qrcode-generator';
import { BrowserMultiFormatReader } from '@zxing/browser';

const $ = id => document.getElementById(id);

const state = {
  month: monthOf(today()),
  screen: 'expenses'
};

const MONTHLY = ['expenses', 'insights'];

document.addEventListener('DOMContentLoaded', async () => {
  initAuth();
  initExpenses();
  initPrices();
  initSettings();
  initSync();
  initYear();

  $('prevMonth').onclick = () => { state.month = shiftMonth(state.month, -1); renderActive(); };
  $('nextMonth').onclick = () => { state.month = shiftMonth(state.month,  1); renderActive(); };

  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => switchScreen(tab.dataset.screen);
  });

  enhanceSelects();

  const migrated = await migrateLegacy();
  $('bootMsg').hidden = true;

  if (CLOUD_ENABLED) {
    const restored = await restoreSession();
    if (!restored) {
      showApp(false);
      return;                       // wait for sign in
    }
  } else {
    // No key configured — run exactly as the offline-only version.
    await seed();
    await bootData();
    showApp(true);
    await renderActive();
  }

  if (migrated) toast('Existing data on this device was carried over.');

  if (import.meta.env.PROD && 'serviceWorker' in navigator && navigator.serviceWorker.register) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});

// Reload anything cached in memory from the database.
async function bootData() {
  window.CURRENCY = await getSetting('currency', '\u20AC');
  window.SAVINGS_TARGET = await getSetting('savingsTarget', 20);
  await fillCategorySelects();
  await fillStoreLists();
}

function switchScreen(name) {
  state.screen = name;
  document.querySelectorAll('.screen').forEach(s => {
    if (s.id === 'screen-auth') return;
    s.hidden = (s.id !== 'screen-' + name);
  });
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.screen === name));
  renderActive();
}

async function renderActive() {
  if (CLOUD_ENABLED && !currentUser) return;

  const monthly = MONTHLY.includes(state.screen);

  $('prevMonth').hidden = !monthly;
  $('nextMonth').hidden = !monthly;
  $('topEyebrow').textContent = monthly ? 'Month' : 'Ledger';
  $('monthLabel').textContent = monthly
    ? monthLabel(state.month)
    : (state.screen === 'prices' ? 'Prices & products' : 'Settings');

  if (state.screen === 'expenses') await renderExpenses();
  if (state.screen === 'prices')   await renderPrices();
  if (state.screen === 'insights') await renderInsights();
  if (state.screen === 'settings') await renderSettings();
}

/* ---------- QR codes ----------
   Generated locally from a plain otpauth:// string, rather than
   trusting a provider's pre-rendered SVG — that SVG turned out to
   come back as raw, unescaped markup that broke depending on exactly
   how it was embedded, and was unverifiable from here besides. This
   way the only input is text we already trust. */

function totpQrSvg(uri) {
  const qr = qrcode(0, 'M');
  qr.addData(uri);
  qr.make();
  return qr.createSvgTag({ scalable: true });
}

/* ---------- confirm / prompt dialog ----------
   A styled stand-in for the browser's native confirm()/prompt(),
   which render with the browser's own chrome ("127.0.0.1 says…") and
   nothing to do with the app's look. Same call shape — awaited,
   resolves to a boolean (confirm) or string|null (prompt) — so every
   existing call site only needed `await` added in front of it. */

function showDialog({ message, okLabel, cancelLabel, danger, inputValue }) {
  return new Promise(resolve => {
    const overlay    = $('dialogOverlay');
    const okBtn       = $('dialogOk');
    const cancelBtn   = $('dialogCancel');
    const inputField  = $('dialogInputField');
    const input       = $('dialogInput');
    const isPrompt    = inputValue !== undefined;

    $('dialogMessage').textContent = message;
    okBtn.textContent = okLabel || 'OK';
    okBtn.className = danger ? 'danger grow' : 'primary grow';
    cancelBtn.textContent = cancelLabel || 'Cancel';
    inputField.hidden = !isPrompt;
    if (isPrompt) input.value = inputValue;

    function close(result) {
      overlay.hidden = true;
      document.removeEventListener('keydown', onKey);
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      resolve(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') close(isPrompt ? null : false);
      if (e.key === 'Enter' && isPrompt) close(input.value);
    }

    okBtn.onclick = () => close(isPrompt ? input.value : true);
    cancelBtn.onclick = () => close(isPrompt ? null : false);
    document.addEventListener('keydown', onKey);

    overlay.hidden = false;
    (isPrompt ? input : okBtn).focus();
  });
}

// opts: { okLabel, cancelLabel, danger }
function appConfirm(message, opts = {}) {
  return showDialog({
    message,
    okLabel: opts.okLabel,
    cancelLabel: opts.cancelLabel,
    danger: opts.danger
  });
}

function appPrompt(message, defaultValue) {
  return showDialog({ message, okLabel: 'Save', inputValue: defaultValue || '' });
}

/* ---------- fancy <select> ----------
   A native <select>'s closed box can be themed with CSS, but the
   OPEN dropdown panel is drawn by the OS/browser itself and ignores
   the page's styles entirely — no way around that with CSS alone.
   This layers a themed trigger + listbox panel on top instead. The
   real <select> stays in the DOM as the actual source of truth (its
   value, its "change" event, everything existing code already reads
   or listens for), just visually hidden — so nothing outside this
   function needs to know it's there. */

function enhanceSelect(select) {
  const wrap = document.createElement('div');
  wrap.className = 'fancy-select';
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.className = 'fancy-select-native';
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'fancy-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  wrap.appendChild(trigger);

  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('viewBox', '0 0 24 24');
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = '<path d="M6 9l6 6 6-6"/>';
  const label = document.createElement('span');
  trigger.appendChild(label);
  trigger.appendChild(chevron);

  const panel = document.createElement('div');
  panel.className = 'fancy-select-panel';
  panel.setAttribute('role', 'listbox');
  panel.hidden = true;
  wrap.appendChild(panel);

  let rows = [];
  let activeIndex = -1;

  function paintPanel() {
    panel.innerHTML = '';
    rows = Array.from(select.options).map((opt, i) => {
      const row = document.createElement('div');
      row.className = 'fancy-select-option';
      row.setAttribute('role', 'option');
      row.textContent = opt.textContent;
      row.dataset.value = opt.value;
      const selected = opt.value === select.value;
      row.setAttribute('aria-selected', String(selected));
      row.classList.toggle('sel', selected);
      row.onclick = () => choose(i);
      panel.appendChild(row);
      return row;
    });
  }

  function paintTrigger() {
    const opt = select.options[select.selectedIndex];
    label.textContent = opt ? opt.textContent : '';
  }

  function setActive(i) {
    activeIndex = i;
    rows.forEach((r, idx) => r.classList.toggle('active', idx === i));
    if (rows[i]) rows[i].scrollIntoView({ block: 'nearest' });
  }

  function choose(i) {
    select.value = rows[i].dataset.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    paintTrigger();
    close();
  }

  function open() {
    paintPanel();
    setActive(select.selectedIndex);
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onOutside, true);
  }

  function close() {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutside, true);
    trigger.focus();
  }

  function onOutside(e) {
    if (!wrap.contains(e.target)) close();
  }

  trigger.onclick = () => (panel.hidden ? open() : close());

  trigger.onkeydown = e => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) e.preventDefault();
    if (panel.hidden && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { open(); return; }
    if (panel.hidden) return;
    if (e.key === 'ArrowDown') setActive(Math.min(activeIndex + 1, rows.length - 1));
    if (e.key === 'ArrowUp') setActive(Math.max(activeIndex - 1, 0));
    if (e.key === 'Enter' || e.key === ' ') choose(activeIndex);
    if (e.key === 'Escape') close();
  };

  // Keep the trigger in sync when app code sets select.value directly
  // (e.g. loading a saved setting), not just when chosen by click/key.
  select.addEventListener('change', paintTrigger);
  new MutationObserver(paintTrigger).observe(select, { childList: true, subtree: true, attributes: true });

  paintTrigger();
}

function enhanceSelects() {
  document.querySelectorAll('select[data-fancy]').forEach(enhanceSelect);
}

/* ---------- barcode scanning ----------
   prices.js is a classic script, not a Vite module, so it can't
   `import` this npm package itself — it calls these two globals
   instead, same as every other legacy-facing helper in this file. */

let scanControls = null;

async function startBarcodeScan(videoElId, onResult, onError) {
  try {
    const devices = await BrowserMultiFormatReader.listVideoInputDevices();
    if (!devices.length) throw new Error('No camera found on this device.');
    const back = devices.find(d => /back|rear|environment/i.test(d.label));
    const deviceId = (back || devices[devices.length - 1]).deviceId;

    const reader = new BrowserMultiFormatReader();
    scanControls = await reader.decodeFromVideoDevice(deviceId, videoElId, (result) => {
      if (result) onResult(result.getText());
    });
  } catch (err) {
    onError(err);
  }
}

function stopBarcodeScan() {
  if (scanControls) { scanControls.stop(); scanControls = null; }
}

/* ---------- toast ---------- */

let toastTimer = null;

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------------------------------------------------------
   The legacy/*.js files are plain classic scripts (not
   modules) and call these by bare name, expecting globals —
   exactly how they behaved before app.js became a module.
--------------------------------------------------------- */
window.$ = $;
window.state = state;
window.MONTHLY = MONTHLY;
window.bootData = bootData;
window.switchScreen = switchScreen;
window.renderActive = renderActive;
window.toast = toast;
window.totpQrSvg = totpQrSvg;
window.appConfirm = appConfirm;
window.appPrompt = appPrompt;
window.startBarcodeScan = startBarcodeScan;
window.stopBarcodeScan = stopBarcodeScan;
