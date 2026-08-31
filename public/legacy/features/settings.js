/* ---------------------------------------------------------
   settings.js — preferences, categories, stores, backup, account
--------------------------------------------------------- */

function initSettings() {
  $('setCurrency').onchange = async () => {
    const v = $('setCurrency').value.trim() || '\u20AC';
    await setSetting('currency', v);
    window.CURRENCY = v;
    await renderActive();
    scheduleSync();
  };

  $('setTarget').onchange = async () => {
    const v = Math.max(0, Math.min(90, Number($('setTarget').value) || 0));
    await setSetting('savingsTarget', v);
    window.SAVINGS_TARGET = v;
    $('setTarget').value = v;
    scheduleSync();
  };

  $('addCategory').onclick = async () => {
    const name = $('newCategory').value.trim();
    if (!name) return;
    await db.categories.put(stamp({
      id: uuid(), name, type: 'expense', monthly_budget: 0
    }));
    $('newCategory').value = '';
    await fillCategorySelects();
    await renderSettings();
    scheduleSync();
  };

  $('addStore').onclick = async () => {
    const name = $('newStore').value.trim();
    if (!name) return;
    await db.stores.put(stamp({ id: uuid(), name, location: '', note: '' }));
    $('newStore').value = '';
    await fillStoreLists();
    await renderSettings();
    scheduleSync();
  };

  $('exportBtn').onclick = doExport;
  $('importFile').onchange = doImport;
  $('syncBtn').onclick = () => syncNow();

  $('deleteDataBtn').onclick = deleteAllData;
}

/* ---------- categories & stores ---------- */

async function renameCategory(id, current) {
  const name = await appPrompt('Rename category', current);
  if (!name || !name.trim()) return;
  const row = await db.categories.get(id);
  await db.categories.put(stamp({ ...row, name: name.trim() }));
  await fillCategorySelects();
  await renderSettings();
  scheduleSync();
}

async function removeCategory(id) {
  const used = (await liveWhere('expenses', 'category_id', id)).length;
  if (used) { toast(`In use by ${used} expenses. Rename it instead.`); return; }
  const row = await db.categories.get(id);
  await db.categories.put(stamp({ ...row, deleted: 1 }));
  await fillCategorySelects();
  await renderSettings();
  scheduleSync();
}

async function renameStore(id, current) {
  const name = await appPrompt('Rename store', current);
  if (!name || !name.trim()) return;
  const row = await db.stores.get(id);
  await db.stores.put(stamp({ ...row, name: name.trim() }));
  await fillStoreLists();
  await renderSettings();
  scheduleSync();
}

async function removeStore(id) {
  const used = (await liveWhere('expenses', 'store_id', id)).length
             + (await liveWhere('prices', 'store_id', id)).length;
  if (used) { toast(`In use by ${used} records. Rename it instead.`); return; }
  const row = await db.stores.get(id);
  await db.stores.put(stamp({ ...row, deleted: 1 }));
  await fillStoreLists();
  await renderSettings();
  scheduleSync();
}

/* ---------- backup ---------- */

async function doExport() {
  const dump = await exportAll();
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ledger-backup-' + today() + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Backup exported. Receipt photos are not included.');
}

async function doImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!await appConfirm('Importing replaces everything currently on this device. Continue?', { okLabel: 'Import' })) {
    e.target.value = ''; return;
  }
  try {
    const dump = JSON.parse(await file.text());
    await importAll(dump);
    await bootData();
    await renderActive();
    await renderSettings();
    toast('Backup restored.');
    scheduleSync(500);
  } catch (err) {
    logError('Backup import failed', err);
    toast('Import failed: ' + err.message);
  }
  e.target.value = '';
}

/* ---------- delete everything ---------- */

async function deleteAllData() {
  const ok = await appConfirmTyped(
    'Deletes every expense, product, price and setting — from the server and this device. This cannot be undone. Export a backup first if you want to keep a copy. Type DELETE to confirm.',
    'DELETE',
    { okLabel: 'Delete everything' }
  );
  if (!ok) return;

  if (CLOUD_ENABLED && currentUser) {
    if (!navigator.onLine) {
      toast('You are offline. Connect first, or the server copy would survive.');
      return;
    }
    try {
      // Children before parents, so nothing trips a foreign key.
      for (const table of [...SYNC_TABLES].reverse()) {
        const { error } = await sb.from(table).delete().eq('user_id', currentUser.id);
        if (error) throw new Error(table + ': ' + error.message);
      }
    } catch (err) {
      logError('Server-side delete-all failed', err);
      toast('Server delete failed: ' + err.message + ' — nothing was removed locally.');
      return;
    }
  }

  await wipeLocal();

  if (CLOUD_ENABLED) {
    await sb.auth.signOut();
    location.reload();
    return;
  }

  await seed();
  await bootData();
  await renderActive();
  await renderSettings();
  toast('Everything deleted.');
}

/* ---------- two-factor authentication ---------- */

let mfaEnrollment = null;   // { factorId, qrCode, secret } while mid-setup

async function startMfaEnroll() {
  // A previous setup attempt that was never verified (tab closed
  // mid-setup, etc.) leaves an orphaned factor behind — Supabase
  // refuses to enroll a new one with a colliding friendly name until
  // it's cleared, so sweep those up first.
  const { data: existing } = await sb.auth.mfa.listFactors();
  const stray = existing && existing.totp ? existing.totp.filter(f => f.status !== 'verified') : [];
  for (const f of stray) await sb.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});

  const { data, error } = await sb.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'authenticator-' + Date.now()
  });
  if (error) { toast('Could not start setup: ' + error.message); return; }
  mfaEnrollment = { factorId: data.id, uri: data.totp.uri, secret: data.totp.secret };
  await renderMfaCard();
}

async function cancelMfaEnroll() {
  if (mfaEnrollment) {
    await sb.auth.mfa.unenroll({ factorId: mfaEnrollment.factorId }).catch(() => {});
  }
  mfaEnrollment = null;
  await renderMfaCard();
}

async function confirmMfaEnroll() {
  const code = $('mfaEnrollCode').value.trim();
  if (!/^\d{6}$/.test(code)) { toast('Enter the 6-digit code from your authenticator app.'); return; }

  $('mfaEnrollVerify').disabled = true;
  try {
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: mfaEnrollment.factorId, code });
    if (error) throw error;
    mfaEnrollment = null;
    await renderMfaCard();
    toast('Two-factor authentication is on.');
  } catch (err) {
    logError('MFA enrollment verify failed', err);
    toast(friendlyAuthError(err));
  } finally {
    const btn = $('mfaEnrollVerify');
    if (btn) btn.disabled = false;
  }
}

async function disableMfa(factorId) {
  if (!await appConfirm('Turn off two-factor authentication? Signing in will only need your password.', { okLabel: 'Turn off', danger: true })) return;
  const { error } = await sb.auth.mfa.unenroll({ factorId });
  if (error) { toast('Could not disable: ' + error.message); return; }
  await renderMfaCard();
  toast('Two-factor authentication is off.');
}

async function renderMfaCard() {
  if (!CLOUD_ENABLED || !currentUser) { $('mfaCard').hidden = true; return; }
  $('mfaCard').hidden = false;

  const body = $('mfaBody');

  if (mfaEnrollment) {
    body.innerHTML = `
      <p class="hint">Scan this with your authenticator app (Google Authenticator, Authy,
        1Password, etc.), then enter the 6-digit code it shows.</p>
      <div class="qrcode" role="img" aria-label="Authenticator setup QR code">${totpQrSvg(mfaEnrollment.uri)}</div>
      <p class="hint">Can&rsquo;t scan it? Enter this key manually instead:</p>
      <span class="mfa-secret">${escapeHtml(mfaEnrollment.secret)}</span>
      <div class="form mfa-enroll-form">
        <div class="field">
          <label for="mfaEnrollCode">6-digit code</label>
          <input type="text" id="mfaEnrollCode" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code">
        </div>
        <div class="row">
          <button class="ghost grow" type="button" onclick="cancelMfaEnroll()">Cancel</button>
          <button class="primary grow" type="button" id="mfaEnrollVerify" onclick="confirmMfaEnroll()">Verify &amp; enable</button>
        </div>
      </div>`;
    return;
  }

  const { data } = await sb.auth.mfa.listFactors();
  const verified = data && data.totp && data.totp.find(f => f.status === 'verified');
  const shieldIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 12.75 11.25 15 15 9.75M21 12c0 4.556-3.752 8.201-8.14 9.847a1.147 1.147 0 0 1-.72 0C7.752 20.201 4 16.556 4 12V6.741c0-.72.474-1.356 1.146-1.598a19.5 19.5 0 0 1 6.294-1.093c.212-.005.424-.005.636 0a19.5 19.5 0 0 1 6.294 1.093c.672.242 1.146.878 1.146 1.598V12Z"/></svg>`;

  body.innerHTML = verified ? `
      <div class="mfarow">
        <span class="mfaicon on">${shieldIcon}</span>
        <div class="mfameta">
          <div class="cat">Two-factor authentication is on</div>
          <div class="sub">Signing in needs your password and a code from your authenticator app.</div>
        </div>
      </div>
      <button class="linkdanger" type="button" onclick="disableMfa('${verified.id}')">Turn off two-factor authentication</button>
    ` : `
      <div class="mfarow">
        <span class="mfaicon">${shieldIcon}</span>
        <div class="mfameta">
          <div class="cat">Two-factor authentication is off</div>
          <div class="sub">Add a code from an authenticator app as a second step when signing in.</div>
        </div>
      </div>
      <button class="primary" type="button" onclick="startMfaEnroll()">Enable two-factor authentication</button>`;
}

// If the stored symbol isn't one of the preset options (an older
// free-typed value, say), add it so the dropdown still shows what's
// actually set instead of silently falling back to the first option.
function setCurrencySelect(value) {
  const sel = $('setCurrency');
  const known = Array.from(sel.options).some(o => o.value === value);
  if (!known) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value + ' (current)';
    sel.insertBefore(opt, sel.firstChild);
  }
  sel.value = value;
}

/* ---------- render ---------- */

async function renderSettings() {
  setCurrencySelect(window.CURRENCY);
  $('setTarget').value = window.SAVINGS_TARGET;

  await renderAccount();
  await renderMfaCard();
  if (CLOUD_ENABLED && currentUser) await setSyncStatus('ok');

  const cats   = (await live('categories')).sort((a, b) => a.name.localeCompare(b.name));
  const stores = (await live('stores')).sort((a, b) => a.name.localeCompare(b.name));

  $('categoryList').innerHTML = cats.map(c => `
    <span class="tag">
      <button class="tagname" onclick="renameCategory('${c.id}', '${escapeAttr(c.name)}')">${escapeHtml(c.name)}</button>
      <button class="tagx" onclick="removeCategory('${c.id}')" aria-label="Remove">&times;</button>
    </span>`).join('');

  $('storeManageList').innerHTML = stores.length
    ? stores.map(s => `
      <span class="tag">
        <button class="tagname" onclick="renameStore('${s.id}', '${escapeAttr(s.name)}')">${escapeHtml(s.name)}</button>
        <button class="tagx" onclick="removeStore('${s.id}')" aria-label="Remove">&times;</button>
      </span>`).join('')
    : '<p class="hint">No stores yet. Add the shops you use, or just type a store name on an expense.</p>';
}

function escapeAttr(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
