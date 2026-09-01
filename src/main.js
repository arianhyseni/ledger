/* ---------------------------------------------------------
   app.js — shell: state, boot, navigation
--------------------------------------------------------- */

// Self-hosted (not Google Fonts' CDN) so the app stays fully usable
// offline — only the three weights actually used are pulled in.
import '@fontsource/inter/400.css';  // Body
import '@fontsource/inter/500.css';  // Subheading / Labels
import '@fontsource/inter/600.css';  // Heading

import './styles/app.css';
import qrcode from 'qrcode-generator';
import { createBarcodeScanner } from './barcode-scanner.js';
import { lookupProductByBarcode } from './product-lookup.js';

const $ = id => document.getElementById(id);

/* ---------- logging ----------
   A consistent tag makes TillRoll's own messages easy to filter from
   library noise in devtools. The two window listeners below exist so
   a failure is never completely silent — that's exactly the shape of
   bug that once left this app stuck on "Loading…" with nothing in
   the console explaining why: something threw before $('bootMsg')
   ever got hidden, and the rejection had nowhere to surface. */

const LOG_TAG = '[TillRoll]';

function log(...args) { console.log(LOG_TAG, ...args); }
function logError(context, err) { console.error(LOG_TAG, context + ':', err); }

const barcodeScanner = createBarcodeScanner({ getElement: $, log });

window.addEventListener('error', e => {
  logError('Uncaught error', e.error || e.message);
});
window.addEventListener('unhandledrejection', e => {
  logError('Unhandled promise rejection', e.reason);
});

const state = {
  month: monthOf(today()),
  screen: 'expenses'
};

const MONTHLY = ['expenses', 'insights'];

document.addEventListener('DOMContentLoaded', async () => {
  try {
    log('boot: starting');
    initThemeToggle();
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

    initCustomControls();

    log('boot: checking for legacy (pre-sync) data to migrate');
    const migrated = await migrateLegacy();
    $('bootMsg').hidden = true;

    if (CLOUD_ENABLED) {
      log('boot: cloud sync enabled — restoring session');
      const restored = await restoreSession();
      if (!restored) {
        log('boot: no session — showing sign-in');
        showApp(false);
        return;                       // wait for sign in
      }
    } else {
      // No key configured — run exactly as the offline-only version.
      log('boot: cloud sync disabled — running offline-only');
      await seed();
      await bootData();
      showApp(true);
      await renderActive();
    }

    if (migrated) toast('Existing data on this device was carried over.');

    if (import.meta.env.PROD && 'serviceWorker' in navigator && navigator.serviceWorker.register) {
      navigator.serviceWorker.register('/sw.js')
        .then(() => log('boot: service worker registered'))
        .catch(err => logError('Service worker registration failed', err));
    }

    log('boot: done');
  } catch (err) {
    logError('Boot failed', err);
    const bootMsg = $('bootMsg');
    if (bootMsg) {
      bootMsg.hidden = false;
      // Static, app-authored markup only — no user or error text is
      // interpolated here, so innerHTML is safe.
      bootMsg.innerHTML = `
        <span class="boot-brand">TillRoll</span>
        <span class="boot-text">TillRoll could not finish opening. Your data is untouched
          on this device — reloading usually fixes this.</span>
        <button class="ghost boot-retry" type="button">Try again</button>`;
      bootMsg.querySelector('.boot-retry').onclick = () => location.reload();
    }
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
  document.querySelectorAll('.tab').forEach(t => {
    const selected = t.dataset.screen === name;
    t.classList.toggle('active', selected);
    if (selected) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  renderActive();
}

async function renderActive() {
  if (CLOUD_ENABLED && !currentUser) return;

  const monthly = MONTHLY.includes(state.screen);
  $('topbar').classList.toggle('monthly', monthly);

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

/* ---------- light / dark theme ---------- */

const THEME_KEY = 'tillroll-theme';
let themeTimer = null;

function savedTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch (_) { return null; }
}

function updateThemeButton() {
  const button = $('themeBtn');
  if (!button) return;
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${next} mode`;
  button.setAttribute('aria-label', label);
  button.title = label;
}

function applyTheme(theme, { animate = false, persist = true } = {}) {
  const root = document.documentElement;
  if (animate) {
    clearTimeout(themeTimer);
    root.classList.add('theme-transition');
  }

  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const themeColor = $('themeColor');
  if (themeColor) themeColor.content = theme === 'dark' ? '#161D24' : '#FFFFFF';
  if (persist) {
    try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
  }
  updateThemeButton();

  if (animate) {
    themeTimer = setTimeout(() => root.classList.remove('theme-transition'), 480);
  }
}

function initThemeToggle() {
  updateThemeButton();
  $('themeBtn').onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next, { animate: true });
  };

  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  systemTheme.addEventListener?.('change', event => {
    if (!savedTheme()) applyTheme(event.matches ? 'dark' : 'light', { animate: true, persist: false });
  });
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

function showDialog({ message, okLabel, cancelLabel, danger, inputValue, requireMatch, placeholder }) {
  return new Promise(resolve => {
    const overlay    = $('dialogOverlay');
    const okBtn       = $('dialogOk');
    const cancelBtn   = $('dialogCancel');
    const inputField  = $('dialogInputField');
    const input       = $('dialogInput');
    const isPrompt    = inputValue !== undefined;
    const isGated     = requireMatch !== undefined;

    const returnFocus = document.activeElement;

    $('dialogMessage').textContent = message;
    okBtn.textContent = okLabel || 'OK';
    okBtn.className = danger ? 'danger grow' : 'primary grow';
    cancelBtn.textContent = cancelLabel || 'Cancel';
    inputField.hidden = !isPrompt;
    if (isPrompt) {
      input.value = inputValue;
      input.placeholder = placeholder || '';
    }

    function checkMatch() {
      if (isGated) okBtn.disabled = input.value !== requireMatch;
    }
    checkMatch();

    function close(result) {
      overlay.hidden = true;
      document.removeEventListener('keydown', onKey);
      input.oninput = null;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      okBtn.disabled = false;
      if (returnFocus && returnFocus.isConnected) returnFocus.focus();
      resolve(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') close(isPrompt ? null : false);
      if (e.key === 'Enter' && isPrompt && !okBtn.disabled) {
        close(isGated ? true : input.value);
      }
      if (e.key === 'Tab') {
        // Contain focus while the dialog is open (§18/§24). Disabled
        // controls (a gated delete button before its word is typed)
        // are skipped, exactly as the browser itself would.
        const ring = [input, cancelBtn, okBtn]
          .filter(el => !el.disabled && !el.closest('[hidden]'));
        if (!ring.length) return;
        const first = ring[0], last = ring[ring.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        else if (!ring.includes(document.activeElement)) { e.preventDefault(); first.focus(); }
      }
    }

    input.oninput = checkMatch;
    okBtn.onclick = () => close(isGated ? true : (isPrompt ? input.value : true));
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

// A stronger confirm for irreversible, wide-blast-radius actions: the
// confirm button stays disabled until the exact word is typed, so it
// can't be tapped through on muscle memory the way two Yes/No dialogs
// in a row can be.
function appConfirmTyped(message, requireMatch, opts = {}) {
  return showDialog({
    message,
    okLabel: opts.okLabel || 'Delete',
    cancelLabel: opts.cancelLabel,
    danger: true,
    inputValue: '',
    requireMatch,
    placeholder: requireMatch
  });
}

/* ---------- floating panel positioning ----------
   A native <select>/<input type="date"> popup always escapes its
   ancestors' `overflow: hidden` — it's rendered outside the page's
   box model entirely. A custom-built replacement is a normal DOM
   node, so anchoring it with `position: absolute` gets it clipped
   the moment it lives inside something like .daygroup (which needs
   overflow: hidden for its own rounded corners). Fixed positioning
   computed from the trigger's real screen position avoids that,
   flipping above the trigger or clamping to the viewport edge when
   there isn't room below/to the right. */

function positionFloatingPanel(trigger, panel, panelWidth) {
  const rect = trigger.getBoundingClientRect();
  const width = panelWidth || rect.width;

  panel.style.position = 'fixed';
  panel.style.width = width + 'px';
  panel.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + 'px';

  const panelHeight = panel.offsetHeight;
  const openUp = window.innerHeight - rect.bottom < panelHeight + 8 && rect.top > panelHeight + 8;
  panel.style.top = (openUp ? rect.top - panelHeight - 6 : rect.bottom + 6) + 'px';
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
  chevron.innerHTML = '<path d="M19.5 8.25l-7.5 7.5-7.5-7.5"/>';
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

  function reposition() { positionFloatingPanel(trigger, panel); }

  function open() {
    paintPanel();
    setActive(select.selectedIndex);
    panel.hidden = false;
    reposition();
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onOutside, true);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
  }

  function close() {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutside, true);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
    trigger.focus();
  }

  function onOutside(e) {
    if (!wrap.contains(e.target) && !panel.contains(e.target)) close();
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

function controlElements(root, selector) {
  const elements = [];
  if (root instanceof Element && root.matches(selector)) elements.push(root);
  if (root.querySelectorAll) elements.push(...root.querySelectorAll(selector));
  return elements;
}

function enhanceSelects(root = document) {
  controlElements(root, 'select:not([data-native])').forEach(el => {
    if (!el.classList.contains('fancy-select-native')) enhanceSelect(el);
  });
}

/* ---------- fancy date input ----------
   Same problem as <select>: an <input type="date">'s closed box can
   be themed, but its OS-drawn calendar popup can't be touched by CSS
   at all. Same fix — a themed trigger + calendar panel on top, with
   the real input kept as the value-holder (still plain YYYY-MM-DD,
   still fires "change", still what today()/monthOf()/etc. read). */

function enhanceDateInput(input) {
  const wrap = document.createElement('div');
  wrap.className = 'fancy-date';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  input.className = 'fancy-date-native';
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'fancy-select-trigger fancy-date-trigger';
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  wrap.appendChild(trigger);

  const label = document.createElement('span');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<path d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5"/>';
  trigger.appendChild(label);
  trigger.appendChild(icon);

  const panel = document.createElement('div');
  panel.className = 'fancy-date-panel';
  panel.hidden = true;
  wrap.appendChild(panel);

  let viewMonth = new Date();

  function paintTrigger() {
    label.textContent = input.value ? dayLabel(input.value) : 'Select a date';
  }

  function paintPanel() {
    const y = viewMonth.getFullYear(), m = viewMonth.getMonth();
    const monthName = viewMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const firstDow = (new Date(y, m, 1).getDay() + 6) % 7; // Monday = 0
    const daysInMo = new Date(y, m + 1, 0).getDate();
    const totalCells = firstDow + daysInMo;
    const trailing = (7 - (totalCells % 7)) % 7;

    let cells = '';
    for (let i = 0; i < firstDow; i++) {
      const d = new Date(y, m, 1 - (firstDow - i));
      cells += `<button type="button" class="fancy-date-cell dim" data-iso="${isoDate(d)}">${d.getDate()}</button>`;
    }
    for (let d = 1; d <= daysInMo; d++) {
      const iso = isoDate(new Date(y, m, d));
      const cls = (iso === input.value ? ' sel' : '') + (iso === today() ? ' today' : '');
      cells += `<button type="button" class="fancy-date-cell${cls}" data-iso="${iso}">${d}</button>`;
    }
    for (let i = 1; i <= trailing; i++) {
      const d = new Date(y, m + 1, i);
      cells += `<button type="button" class="fancy-date-cell dim" data-iso="${isoDate(d)}">${d.getDate()}</button>`;
    }

    panel.innerHTML = `
      <div class="fancy-date-head">
        <button type="button" class="fancy-date-nav" data-move="-1" aria-label="Previous month">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.75 19.5 8.25 12l7.5-7.5"/></svg>
        </button>
        <span class="fancy-date-month">${monthName}</span>
        <button type="button" class="fancy-date-nav" data-move="1" aria-label="Next month">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.25 4.5l7.5 7.5-7.5 7.5"/></svg>
        </button>
      </div>
      <div class="fancy-date-weekdays">
        <span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span><span>Su</span>
      </div>
      <div class="fancy-date-grid">${cells}</div>
      <div class="fancy-date-foot">
        <button type="button" class="fancy-date-today">Today</button>
      </div>`;

    panel.querySelectorAll('.fancy-date-nav').forEach(btn => {
      btn.onclick = () => {
        viewMonth = new Date(y, m + Number(btn.dataset.move), 1);
        paintPanel();
      };
    });
    panel.querySelectorAll('.fancy-date-cell').forEach(btn => {
      btn.onclick = () => choose(btn.dataset.iso);
    });
    panel.querySelector('.fancy-date-today').onclick = () => choose(today());
  }

  function choose(iso) {
    input.value = iso;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    paintTrigger();
    close();
  }

  function reposition() { positionFloatingPanel(trigger, panel, 300); }

  function open() {
    const base = input.value ? new Date(input.value + 'T00:00:00') : new Date();
    viewMonth = new Date(base.getFullYear(), base.getMonth(), 1);
    paintPanel();
    panel.hidden = false;
    reposition();
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onOutside, true);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
  }

  function close() {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutside, true);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
  }

  function onOutside(e) {
    if (!wrap.contains(e.target) && !panel.contains(e.target)) close();
  }

  trigger.onclick = () => (panel.hidden ? open() : close());
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !panel.hidden) close();
  });

  input.addEventListener('change', paintTrigger);
  new MutationObserver(paintTrigger).observe(input, { attributes: true });

  paintTrigger();
}

function enhanceDateInputs(root = document) {
  controlElements(root, 'input[type="date"]:not([data-native])').forEach(el => {
    if (!el.classList.contains('fancy-date-native')) enhanceDateInput(el);
  });
}

/* ---------- shared custom-control API ----------
   Every select and date input uses the TillRoll control by default.
   Add data-native only when a future field deliberately needs the OS widget.
   Calling enhance(root) is useful after rendering a large subtree; the observer
   below also catches controls inserted later so a missed call cannot leave a
   browser-native dropdown or date picker in the interface. */

function enhanceCustomControls(root = document) {
  enhanceSelects(root);
  enhanceDateInputs(root);
}

let customControlsObserver = null;

function initCustomControls() {
  enhanceCustomControls();
  if (customControlsObserver) return;

  customControlsObserver = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) enhanceCustomControls(node);
      }
    }
  });
  customControlsObserver.observe(document.body, { childList: true, subtree: true });
}

/* ---------- barcode scanning ----------
   prices.js is a classic script, not a Vite module, so it can't
   `import` this npm package itself — it calls these two globals
   instead, same as every other legacy-facing helper in this file.

   ZXing's full decode engine is large (every barcode/QR/PDF417/Aztec
   format), so it's lazy-loaded here on first scan rather than bundled
   into the app's normal boot path — nobody pays for it until they
   actually tap "scan". */

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
window.appConfirmTyped = appConfirmTyped;
window.log = log;
window.logError = logError;
window.TillRollControls = {
  enhance: enhanceCustomControls,
  enhanceSelects,
  enhanceDateInputs
};
window.startBarcodeScan = barcodeScanner.start;
window.stopBarcodeScan = barcodeScanner.stop;
window.switchBarcodeCamera = barcodeScanner.switchCamera;
window.lookupProductByBarcode = lookupProductByBarcode;
