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
import { billTiming, nextBillDueDate, recurrenceLabel } from './bill-schedule.js';
import { scanBillDocument } from './bill-ocr.js';
import { buildBillAlerts, buildBillTrend } from './bill-insights.js';
import { parseBillPaymentCode, parseBillQrPayload } from './bill-qr.js';
import {
  monthIndex, monthFromIndex, isRecurringActiveInMonth, monthsToMaterialize, durationLabel
} from './recurring-expense-schedule.js';

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
  screen: 'home',
  settingsSub: null
};

const MONTHLY = ['home', 'expenses', 'bills', 'insights'];

document.addEventListener('DOMContentLoaded', async () => {
  try {
    log('boot: starting');
    initThemeToggle();
    initAuth();
    initExpenses();
    initBills();
    initHome();
    initAddExpenseSheet();
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
  await migrateDebtToRecurringExpense();
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

  if (state.screen === 'home')     await renderHome();
  if (state.screen === 'expenses') await renderExpenses();
  if (state.screen === 'bills')    await renderBills();
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

/* ---------- bottom sheet ----------
   A slide-up panel for the new pickers (move category, choose a
   recurring expense's duration, edit-scope) — visually distinct from
   showDialog's centered modal, but the same on-page footprint: one
   overlay element in index.html, filled and shown on demand rather
   than templated per call site. Does not replace .fancy-select/
   .fancy-date, which keep their own dropdown-panel mechanism. */

let sheetReturnFocus = null;

function onSheetKey(e) {
  if (e.key === 'Escape') closeBottomSheet();
}

// html: the sheet body markup (a title + whatever picker rows).
// wire: optional callback(sheetEl) run after the markup is in the DOM,
// for attaching click handlers to the freshly rendered rows.
function openBottomSheet(html, wire) {
  const overlay = $('sheetOverlay');
  const backdrop = $('sheetBackdrop');
  const sheet = $('sheetBody');

  sheetReturnFocus = document.activeElement;
  sheet.innerHTML = html;
  overlay.hidden = false;
  backdrop.onclick = closeBottomSheet;
  document.addEventListener('keydown', onSheetKey);

  if (typeof wire === 'function') wire(sheet);

  const focusable = sheet.querySelector('button, [href], input, select, textarea, [tabindex]');
  (focusable || sheet).focus?.();
}

function closeBottomSheet() {
  const overlay = $('sheetOverlay');
  if (overlay.hidden) return;
  overlay.hidden = true;
  $('sheetBody').innerHTML = '';
  document.removeEventListener('keydown', onSheetKey);
  if (sheetReturnFocus && sheetReturnFocus.isConnected) sheetReturnFocus.focus();
  sheetReturnFocus = null;
}

/* ---------- add-expense sheet ----------
   A full-screen keypad entry flow: type an amount, tap a category
   tile, optionally mark it repeating or add a note, save. The
   decorative camera key from the design is wired to the same
   hidden-file-input receipt flow the inline form already used, so
   nothing about receipts is lost by replacing that form. Any
   category not in the quick 6 stays reachable through "More…", which
   opens the exact same fancy-select the inline form used. */

const addExpenseState = {
  cents: '', categoryId: '', repeat: false,
  durationMode: 'open', untilMonth: '', noteOpen: false, returnFocus: null
};

async function mostUsedCategoryIds(limit) {
  const cutoff = shiftMonth(monthOf(today()), -3) + '-01';
  const recent = (await live('expenses')).filter(e => e.date >= cutoff && e.category_id);
  const counts = {};
  for (const e of recent) counts[e.category_id] = (counts[e.category_id] || 0) + 1;
  const cats = (await live('categories')).sort((a, b) => a.name.localeCompare(b.name));
  const ranked = cats
    .map(c => ({ c, n: counts[c.id] || 0 }))
    .sort((a, b) => b.n - a.n || a.c.name.localeCompare(b.c.name))
    .map(({ c }) => c);
  return ranked.slice(0, limit);
}

function addExpenseAmountValue() {
  return addExpenseState.cents ? parseInt(addExpenseState.cents, 10) : 0;
}

function paintAddExpenseAmount() {
  const cents = addExpenseAmountValue();
  const el = $('keypadAmount');
  el.textContent = fromCents(cents);
  el.classList.toggle('dim', !addExpenseState.cents);
  $('addExpenseSave').disabled = cents <= 0;
}

function paintAddExpenseCats(cats) {
  $('addExpenseCats').innerHTML = cats.map(c => `
    <button type="button" class="quickcat${c.id === addExpenseState.categoryId ? ' sel' : ''}" data-cat="${c.id}">
      <span class="icon-tile icon-tile-${c.group || 'variable'}">${categoryIconSvg(c.name)}</span>
      <span>${c.name}</span>
    </button>`).join('') +
    `<button type="button" class="quickcat" id="addExpenseMoreCat">
      <span class="icon-tile icon-tile-variable"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg></span>
      <span>More…</span>
    </button>`;

  $('addExpenseCats').querySelectorAll('.quickcat[data-cat]').forEach(btn => {
    btn.onclick = () => {
      addExpenseState.categoryId = btn.dataset.cat;
      $('addExpenseCats').querySelectorAll('.quickcat').forEach(b => b.classList.toggle('sel', b === btn));
    };
  });
  $('addExpenseMoreCat').onclick = () => $('exCategory').closest('.fancy-select').querySelector('.fancy-select-trigger').click();
}

function paintAddExpenseRepeat() {
  $('addExpenseRepeatToggle').setAttribute('aria-expanded', String(addExpenseState.repeat));
  $('addExpenseRepeatToggle').classList.toggle('on', addExpenseState.repeat);
  $('repeatSpans').hidden = !addExpenseState.repeat;
  $('repeatSpans').querySelectorAll('.repeatspan').forEach(btn =>
    btn.classList.toggle('sel', btn.dataset.span === addExpenseState.durationMode));
  $('repeatUntilField').hidden = addExpenseState.durationMode !== 'until';
}

async function openAddExpenseSheet() {
  addExpenseState.cents = '';
  addExpenseState.categoryId = '';
  addExpenseState.repeat = false;
  addExpenseState.durationMode = 'open';
  addExpenseState.untilMonth = '';
  addExpenseState.noteOpen = false;
  addExpenseState.returnFocus = document.activeElement;
  window.pendingReceiptPhoto = null;

  $('addExpensePhotoChip').hidden = true;
  $('addExpenseNote').value = '';
  $('addExpenseNote').hidden = true;
  $('addExpenseNoteToggle').hidden = false;
  $('addExpensePhoto').value = '';
  $('addExpenseFullField').value = '';

  const cats = await mostUsedCategoryIds(6);
  if (cats.length && !addExpenseState.categoryId) addExpenseState.categoryId = cats[0].id;
  paintAddExpenseCats(cats);
  paintAddExpenseAmount();
  paintAddExpenseRepeat();

  $('addExpenseSheet').hidden = false;
  document.addEventListener('keydown', onAddExpenseKey);
}

function onAddExpenseKey(e) {
  if (e.key === 'Escape') closeAddExpenseSheet();
}

function closeAddExpenseSheet() {
  $('addExpenseSheet').hidden = true;
  document.removeEventListener('keydown', onAddExpenseKey);
  if (addExpenseState.returnFocus && addExpenseState.returnFocus.isConnected) addExpenseState.returnFocus.focus();
}

function initAddExpenseSheet() {
  $('fabAdd').onclick = openAddExpenseSheet;
  $('expensesAddBtn').onclick = openAddExpenseSheet;
  $('addExpenseCancel').onclick = closeAddExpenseSheet;

  $('addExpenseKeypad').querySelectorAll('.keypad-key').forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.key;
      if (key === 'cam') { $('addExpensePhoto').click(); return; }
      if (key === 'del') { addExpenseState.cents = addExpenseState.cents.slice(0, -1); }
      else if (addExpenseState.cents.length < 7) {
        if (!addExpenseState.cents && key === '0') { /* leading zero, ignore */ }
        else addExpenseState.cents += key;
      }
      paintAddExpenseAmount();
    };
  });

  $('addExpensePhoto').onchange = e => {
    window.pendingReceiptPhoto = e.target.files[0] || null;
    $('addExpensePhotoChip').hidden = !window.pendingReceiptPhoto;
  };

  $('addExpenseRepeatToggle').onclick = () => {
    addExpenseState.repeat = !addExpenseState.repeat;
    paintAddExpenseRepeat();
  };
  $('repeatSpans').querySelectorAll('.repeatspan').forEach(btn => {
    btn.onclick = () => { addExpenseState.durationMode = btn.dataset.span; paintAddExpenseRepeat(); };
  });
  $('repeatUntilMonth').onchange = () => { addExpenseState.untilMonth = $('repeatUntilMonth').value; };

  $('addExpenseNoteToggle').onclick = () => {
    addExpenseState.noteOpen = true;
    $('addExpenseNote').hidden = false;
    $('addExpenseNoteToggle').hidden = true;
    $('addExpenseNote').focus();
  };

  $('addExpenseSave').onclick = async () => {
    const amount = addExpenseAmountValue();
    if (amount <= 0) return;

    try {
      await buildAndSaveExpense({
        amount,
        date: today(),
        categoryId: addExpenseState.categoryId,
        storeName: '',
        note: $('addExpenseNote').value,
        photo: window.pendingReceiptPhoto,
        repeat: addExpenseState.repeat ? {
          durationMode: addExpenseState.durationMode,
          durationMonths: 12,
          untilMonth: addExpenseState.untilMonth || null
        } : null
      });
    } catch (err) {
      toast(err.message);
      return;
    }

    closeAddExpenseSheet();
    toast('Expense saved.');
  };
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

/* ---------- category icons ----------
   Real stroke SVGs (24x24, matching every other icon in the app)
   keyed by a loose match on the category name, so seeded and
   custom categories alike get a sensible glyph with no emoji
   anywhere in the shipped UI. Falls back to a generic tag icon. */

const CATEGORY_ICONS = [
  [/grocer|food|market/i, '<path d="M4 4h1.5l1.09 9.36A2 2 0 0 0 8.58 15H17a2 2 0 0 0 1.98-1.72L20 8H6"/><circle cx="9" cy="19.5" r="1.25"/><circle cx="16.5" cy="19.5" r="1.25"/>'],
  [/transport|fuel|petrol|gas station|car|bus|taxi/i, '<path d="M4.5 16.5V11l1.8-4.2A2 2 0 0 1 8.1 5.5h7.8a2 2 0 0 1 1.8 1.3l1.8 4.2v5.5"/><path d="M4.5 16.5h15M6.5 16.5V19M17.5 16.5V19"/><circle cx="7.5" cy="13.5" r="1"/><circle cx="16.5" cy="13.5" r="1"/>'],
  [/health|pharmac|doctor|medical/i, '<circle cx="12" cy="12" r="8.25"/><path d="M12 8.25v7.5M8.25 12h7.5"/>'],
  [/cloth|apparel|fashion/i, '<path d="M9 4.5 6 6.75 4.5 9.75 7.5 11.25V19.5h9V11.25l3-1.5L18 6.75 15 4.5a3 3 0 0 1-6 0Z"/>'],
  [/eating out|restaurant|dining|cafe|coffee/i, '<path d="M6 3v6a2.5 2.5 0 0 0 5 0V3M8.5 9v12M17 3v18M17 3c2 0 3 1.5 3 4s-1 4-3 4"/>'],
  [/kid|child|school/i, '<path d="M12 3 3 7l9 4 9-4-9-4Z"/><path d="M6.5 9.5V15c0 1.5 2.5 3 5.5 3s5.5-1.5 5.5-3V9.5"/>'],
  [/entertain|movie|cinema|game/i, '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M9.5 9.5v5l4.5-2.5-4.5-2.5Z"/>'],
  [/bill|utilit|electric|water|internet|phone|rent|insurance|subscription/i, '<path d="M6 3.75h12a1.5 1.5 0 0 1 1.5 1.5v15l-2.5-1.5-2.5 1.5-2.5-1.5-2.5 1.5-2.5-1.5-2.5 1.5v-15A1.5 1.5 0 0 1 6 3.75Z"/><path d="M8 8.25h8M8 12h8M8 15.75h4"/>'],
  [/loan|bank|mortgage/i, '<path d="M4 10.5 12 5l8 5.5"/><path d="M5.5 10.5V19h13v-8.5"/><path d="M9.5 19v-5.5h5V19"/>'],
  [/household|home|furniture/i, '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/>']
];

function categoryIconSvg(name) {
  const match = CATEGORY_ICONS.find(([pattern]) => pattern.test(name || ''));
  const inner = match ? match[1] : '<path d="M9.568 3H5.25A2.25 2.25 0 0 0 3 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 0 0 5.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 0 0 9.568 3Z"/><path d="M6 6h.008v.008H6V6Z"/>';
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
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
window.TillRollBills = {
  billTiming,
  nextBillDueDate,
  recurrenceLabel,
  buildBillAlerts,
  buildBillTrend,
  parseBillPaymentCode,
  parseBillQrPayload
};
window.scanBillDocument = scanBillDocument;
window.TillRollRecurring = {
  monthIndex,
  monthFromIndex,
  isRecurringActiveInMonth,
  monthsToMaterialize,
  durationLabel
};
window.openBottomSheet = openBottomSheet;
window.closeBottomSheet = closeBottomSheet;
window.openAddExpenseSheet = openAddExpenseSheet;
window.categoryIconSvg = categoryIconSvg;
