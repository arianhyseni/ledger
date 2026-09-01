/* ---------------------------------------------------------
   bills.js — recurring bill accounts and monthly occurrences
--------------------------------------------------------- */

const BILL_TYPE_LABELS = {
  electricity: 'Electricity', water: 'Water', gas: 'Gas', internet: 'Internet',
  phone: 'Phone', rent: 'Rent', insurance: 'Insurance',
  subscription: 'Subscription', other: 'Other'
};
const billsBeingPaid = new Set();
let billScheduleQueue = Promise.resolve();
let pendingBillDocument = null;
let billPreviewUrl = '';
let billScanId = 0;

function initBills() {
  $('billForm').onsubmit = saveBillAccount;
  $('bDueDate').value = today();
  $('billScanCamera').onchange = event => selectBillDocument(event.target.files[0]);
  $('billScanFile').onchange = event => selectBillDocument(event.target.files[0]);
  $('billQrScanBtn').onclick = openBillQrScanner;
  $('billScanRemove').onclick = () => clearBillDocumentScan();
  for (const id of ['bName', 'bType', 'bAmount', 'bDueDate', 'bAccountRef', 'bUsage', 'bUsageUnit']) {
    $(id).addEventListener('input', () => $(id).closest('.field').classList.remove('ocr-suggested'));
    $(id).addEventListener('change', () => $(id).closest('.field').classList.remove('ocr-suggested'));
  }
}

function openBillQrScanner() {
  openScanner({
    mode: 'payment',
    hint: 'Point the camera at the bill barcode or QR',
    onCode: onBillQrScanned
  });
}

function onBillQrScanned(payload) {
  closeScanner();
  const result = window.TillRollBills.parseBillPaymentCode(payload, { allowLinear: true });
  if (!result.recognized) {
    setBillScanStatus(
      'Code scanned, but it did not contain a usable bill reference. Photograph the bill instead.',
      { progress: 1, tone: 'bad' }
    );
    return;
  }

  let suggestions = 0;
  if (!$('bName').value.trim()) suggestions += Number(markOcrSuggestion('bName', result.provider));
  if (!$('bAmount').value.trim() && result.amountCents !== null) {
    suggestions += Number(markOcrSuggestion('bAmount', fromCents(result.amountCents)));
  }
  if (!$('bAccountRef').value.trim()) {
    suggestions += Number(markOcrSuggestion('bAccountRef', result.accountReference));
  }
  const warning = billCurrencyWarning(result.currency);
  setBillScanStatus(
    suggestions
      ? `${suggestions} field${suggestions === 1 ? '' : 's'} suggested from the bill code. Review the highlighted values.${warning}`
      : `The bill code was recognized but had no new details to fill.${warning}`,
    { progress: 1, tone: warning ? 'bad' : 'ok' }
  );
}

function billFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function setBillScanStatus(message, { progress, tone } = {}) {
  $('billScanProgress').hidden = false;
  $('billScanStatus').textContent = message;
  $('billScanStatus').className = `hint${tone ? ` ${tone}` : ''}`;
  if (Number.isFinite(progress)) $('billScanProgressBar').value = Math.round(progress * 100);
}

function ocrProgressLabel(status) {
  const labels = {
    'loading tesseract core': 'Loading the text reader…',
    'initializing tesseract': 'Preparing text recognition…',
    'loading language traineddata': 'Loading Albanian, English and Serbian recognition data…',
    'initializing api': 'Preparing bill recognition…',
    'recognizing text': 'Reading the bill…',
    'reading PDF': 'Reading the PDF…',
    'reading boxed fields': 'Checking boxed fields and isolated values…',
    'reading embedded text': 'Reading the PDF text…'
  };
  return labels[status] || 'Reading the bill…';
}

function markOcrSuggestion(id, value) {
  if (value === null || value === undefined || value === '') return false;
  const input = $(id);
  input.value = value;
  input.closest('.field').classList.add('ocr-suggested');
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.closest('.field').classList.add('ocr-suggested');
  return true;
}

function billCurrencyWarning(currency) {
  if (!currency) return '';
  const selected = String(window.CURRENCY || '€').trim();
  const matches = {
    EUR: selected === '€' || selected.toUpperCase() === 'EUR',
    HUF: selected.toUpperCase() === 'FT' || selected.toUpperCase() === 'HUF',
    USD: selected === '$' || selected.toUpperCase() === 'USD',
    GBP: selected === '£' || selected.toUpperCase() === 'GBP'
  };
  return matches[currency] === false
    ? ` The document uses ${currency}, while TillRoll is set to ${selected}; check the amount.`
    : '';
}

function applyBillScanResult(result) {
  let count = 0;
  if (!$('bName').value.trim()) count += Number(markOcrSuggestion('bName', result.provider));
  if (!$('bAmount').value.trim() && result.amountCents !== null) {
    count += Number(markOcrSuggestion('bAmount', fromCents(result.amountCents)));
  }
  if (result.dueDate) count += Number(markOcrSuggestion('bDueDate', result.dueDate));
  if (result.utilityType) count += Number(markOcrSuggestion('bType', result.utilityType));
  if (!$('bAccountRef').value.trim()) {
    count += Number(markOcrSuggestion('bAccountRef', result.accountReference));
  }
  if (!$('bUsage').value.trim() && result.usage !== null) {
    count += Number(markOcrSuggestion('bUsage', result.usage));
  }
  if (result.usageUnit) count += Number(markOcrSuggestion('bUsageUnit', result.usageUnit));
  return count;
}

async function selectBillDocument(file) {
  if (!file) return;
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isImage = file.type.startsWith('image/') || /\.(?:bmp|gif|jpe?g|png|webp)$/i.test(file.name);
  const supported = isImage || isPdf;
  if (!supported) { toast('Choose a photo or PDF bill.'); return; }
  if (file.size > 15 * 1024 * 1024) { toast('Bill files must be 15 MB or smaller.'); return; }

  clearBillDocumentScan();
  const scanId = ++billScanId;
  pendingBillDocument = file;
  $('billScanPreview').hidden = false;
  $('billScanFileName').textContent = file.name || 'Photographed bill';
  $('billScanFileMeta').textContent = `${isPdf ? 'PDF' : 'Image'} · ${billFileSize(file.size)}`;
  if (isImage) {
    billPreviewUrl = URL.createObjectURL(file);
    $('billScanImage').src = billPreviewUrl;
    $('billScanImage').hidden = false;
  }
  setBillScanStatus('Preparing the document…', { progress: 0 });

  try {
    const result = await window.scanBillDocument(file, {
      onProgress(message) {
        if (scanId !== billScanId) return;
        setBillScanStatus(ocrProgressLabel(message.status), { progress: message.progress || 0 });
      }
    });
    if (scanId !== billScanId) return;
    const suggestions = applyBillScanResult(result);
    const warning = billCurrencyWarning(result.currency);
    if (suggestions) {
      setBillScanStatus(
        `${suggestions} field${suggestions === 1 ? '' : 's'} suggested. Review the highlighted values.${warning}`,
        { progress: 1, tone: warning ? 'bad' : 'ok' }
      );
    } else {
      setBillScanStatus(`No reliable fields were found. Enter the details manually.${warning}`, { progress: 1, tone: 'bad' });
    }
  } catch (error) {
    if (scanId !== billScanId) return;
    logError('Bill recognition failed', error);
    const offline = !navigator.onLine
      ? ' Connect once to load the recognition data, then try again.'
      : '';
    setBillScanStatus(`Could not read this document.${offline} You can still enter the bill manually.`, { tone: 'bad' });
  }
}

function clearBillDocumentScan() {
  billScanId++;
  pendingBillDocument = null;
  if (billPreviewUrl) URL.revokeObjectURL(billPreviewUrl);
  billPreviewUrl = '';
  $('billScanCamera').value = '';
  $('billScanFile').value = '';
  $('billScanImage').src = '';
  $('billScanImage').hidden = true;
  $('billScanPreview').hidden = true;
  $('billScanProgress').hidden = true;
  $('billScanProgressBar').value = 0;
  $('billScanStatus').textContent = '';
  for (const field of $('billForm').querySelectorAll('.ocr-suggested')) field.classList.remove('ocr-suggested');
}

async function billsCategoryId() {
  const categories = await live('categories');
  const match = categories.find(c => c.name.toLowerCase() === 'bills & utilities');
  return match ? match.id : null;
}

async function saveBillAccount(e) {
  e.preventDefault();

  const name = $('bName').value.trim();
  const amount = toCents($('bAmount').value);
  const dueDate = $('bDueDate').value;
  if (!name || amount <= 0 || !dueDate) {
    toast('Enter a bill name, amount and due date.');
    return;
  }

  const recurrence = $('bRecurrence').value;
  const accountId = uuid();
  const dueDay = Number(dueDate.slice(8, 10));
  const nextDueDate = window.TillRollBills.nextBillDueDate(dueDate, recurrence, dueDay);
  const usageText = $('bUsage').value.trim();
  const usage = usageText === '' ? null : Number(usageText);
  const categoryId = await billsCategoryId();

  const account = stamp({
    id: accountId,
    name,
    utility_type: $('bType').value,
    account_reference: $('bAccountRef').value.trim(),
    category_id: categoryId,
    recurrence,
    default_amount: amount,
    due_day: dueDay,
    next_due_date: nextDueDate,
    note: $('bNote').value.trim(),
    active: recurrence !== 'once'
  });
  const bill = stamp({
    id: uuid(),
    account_id: accountId,
    due_date: dueDate,
    month: monthOf(dueDate),
    amount,
    usage: Number.isFinite(usage) && usage >= 0 ? usage : null,
    usage_unit: $('bUsageUnit').value,
    status: 'due',
    paid_date: null,
    expense_id: null,
    note: $('bNote').value.trim(),
    has_document: !!pendingBillDocument
  });

  await db.transaction('rw', db.bill_accounts, db.bills, db.bill_documents, async () => {
    await db.bill_accounts.put(account);
    await db.bills.put(bill);
    if (pendingBillDocument) {
      await db.bill_documents.put({
        id: uuid(),
        bill_id: bill.id,
        blob: pendingBillDocument,
        name: pendingBillDocument.name || 'bill-photo',
        mime: pendingBillDocument.type || 'application/octet-stream',
        created_at: now()
      });
    }
  });

  $('billForm').reset();
  clearBillDocumentScan();
  $('bDueDate').value = today();
  for (const id of ['bType', 'bRecurrence', 'bUsageUnit', 'bDueDate']) {
    $(id).dispatchEvent(new Event('change', { bubbles: true }));
  }
  state.month = monthOf(dueDate);
  await renderActive();
  toast('Bill saved.');
  scheduleSync();
}

function billScheduleHorizon(month) {
  const latestMonth = month > monthOf(today()) ? month : monthOf(today());
  return `${latestMonth}-${String(daysInMonth(latestMonth)).padStart(2, '0')}`;
}

function ensureScheduledBills(month) {
  const run = billScheduleQueue.then(() => materializeScheduledBills(month));
  // Keep the queue usable after a failed run while still returning the real
  // rejection to the caller that requested it.
  billScheduleQueue = run.catch(() => {});
  return run;
}

async function materializeScheduledBills(month) {
  const accounts = await live('bill_accounts');
  const horizon = billScheduleHorizon(month);
  let changed = false;

  for (const original of accounts) {
    if (!original.active || !original.next_due_date) continue;
    let account = original;
    let guard = 0;

    while (account.next_due_date && account.next_due_date <= horizon && guard++ < 120) {
      const dueDate = account.next_due_date;
      const existing = await db.bills
        .where('[account_id+due_date]')
        .equals([account.id, dueDate])
        .first();

      if (!existing) {
        await db.bills.put(stamp({
          id: uuid(), account_id: account.id, due_date: dueDate,
          month: monthOf(dueDate), amount: account.default_amount || 0,
          usage: null, usage_unit: '', status: 'due', paid_date: null,
          expense_id: null, note: account.note || '', has_document: false
        }));
      }

      account = stamp({
        ...account,
        next_due_date: window.TillRollBills.nextBillDueDate(
          dueDate, account.recurrence, account.due_day
        )
      });
      await db.bill_accounts.put(account);
      changed = true;
    }
  }

  if (changed) scheduleSync();
}

async function markBillPaid(id) {
  if (billsBeingPaid.has(id)) return;
  billsBeingPaid.add(id);
  try {
    const bill = await db.bills.get(id);
    if (!bill || bill.deleted || bill.status === 'paid') return;
    const account = await db.bill_accounts.get(bill.account_id);
    if (!account || account.deleted) return;

    const ok = await appConfirm(
      `Mark ${account.name} paid and add ${money(bill.amount)} to expenses?`,
      { okLabel: 'Mark paid' }
    );
    if (!ok) return;

    const paidDate = today();
    const expenseId = uuid();
    const type = BILL_TYPE_LABELS[account.utility_type] || 'Bill';
    const categoryId = account.category_id || await billsCategoryId();
    await db.transaction('rw', db.expenses, db.bills, async () => {
      await db.expenses.put(stamp({
        id: expenseId,
        date: paidDate,
        month: monthOf(paidDate),
        amount: bill.amount,
        category_id: categoryId,
        store_id: null,
        note: `${type} bill · ${account.name}`,
        has_receipt: false
      }));
      await db.bills.put(stamp({
        ...bill,
        status: 'paid',
        paid_date: paidDate,
        expense_id: expenseId
      }));
    });

    await renderBills();
    toast('Bill paid and added to expenses.');
    scheduleSync();
  } finally {
    billsBeingPaid.delete(id);
  }
}

async function editBill(id) {
  const bill = await db.bills.get(id);
  if (!bill || bill.deleted || bill.status === 'paid') return;

  const amountText = await appPrompt('Update the bill amount', fromCents(bill.amount));
  if (amountText === null) return;
  const amount = toCents(amountText);
  if (amount <= 0) { toast('Enter an amount above zero.'); return; }

  const usageText = await appPrompt(
    'Usage amount (leave empty when it does not apply)',
    bill.usage === null || bill.usage === undefined ? '' : String(bill.usage)
  );
  if (usageText === null) return;
  const usage = usageText.trim() === '' ? null : Number(usageText.replace(',', '.'));
  if (usage !== null && (!Number.isFinite(usage) || usage < 0)) {
    toast('Usage must be zero or more.');
    return;
  }

  await db.bills.put(stamp({ ...bill, amount, usage }));
  await renderBills();
  toast('Bill updated.');
  scheduleSync();
}

async function stopBillRecurrence(accountId) {
  const account = await db.bill_accounts.get(accountId);
  if (!account || account.deleted || !account.active) return;
  if (!await appConfirm(
    `Stop creating future ${account.name} bills? Existing bills will remain.`,
    { okLabel: 'Stop repeating', danger: true }
  )) return;

  await db.bill_accounts.put(stamp({ ...account, active: false, next_due_date: null }));
  await renderBills();
  toast('Future bills stopped.');
  scheduleSync();
}

async function deleteBill(id) {
  const bill = await db.bills.get(id);
  if (!bill || bill.deleted) return;
  const extra = bill.expense_id ? ' The linked expense will remain.' : '';
  if (!await appConfirm(`Delete this bill?${extra}`, { okLabel: 'Delete', danger: true })) return;
  await db.bills.put(stamp({ ...bill, deleted: 1 }));
  await db.bill_documents.where('bill_id').equals(id).delete();
  await renderBills();
  toast('Bill deleted.');
  scheduleSync();
}

async function openBillDocument(billId) {
  const documentRow = await db.bill_documents.where('bill_id').equals(billId).first();
  if (!documentRow) {
    toast('This bill document is stored only on the device where it was attached.');
    return;
  }
  openViewerBlob(documentRow.blob, {
    label: 'Bill document',
    alt: documentRow.name || 'Bill document'
  });
}

function maskedAccountReference(value) {
  const clean = String(value || '').trim();
  if (!clean) return '';
  return clean.length <= 4 ? clean : `••••${clean.slice(-4)}`;
}

function billStatusLabel(timing) {
  return ({ paid: 'Paid', overdue: 'Overdue', soon: 'Due soon', due: 'Upcoming' })[timing];
}

function billAlertText(alert) {
  if (alert.kind === 'overdue') {
    return `${alert.provider} is ${alert.days} day${alert.days === 1 ? '' : 's'} overdue · ${money(alert.amountCents)}`;
  }
  if (alert.kind === 'due-soon') {
    const when = alert.days === 0 ? 'due today' : `due in ${alert.days} day${alert.days === 1 ? '' : 's'}`;
    return `${alert.provider} is ${when} · ${money(alert.amountCents)}`;
  }
  if (alert.kind === 'usage-spike') {
    return `${alert.provider} usage is ${alert.percent}% above its recent average · ${Number(alert.value).toLocaleString()} ${alert.unit}`;
  }
  return `${alert.provider} cost is ${alert.percent}% above its recent average · ${money(alert.value)}`;
}

function renderBillAlerts(bills, accounts) {
  const panel = $('billAlerts');
  const alerts = window.TillRollBills.buildBillAlerts(bills, accounts, today());
  if (!alerts.length) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }

  const shown = alerts.slice(0, 6);
  panel.hidden = false;
  panel.innerHTML = `
    <div class="bill-alert-head">
      <span class="eyebrow">Needs attention</span>
      <span class="bill-alert-count">${alerts.length}</span>
    </div>
    <div class="bill-alert-list">
      ${shown.map(alert => `
        <div class="bill-alert ${alert.tone}">
          <span class="bill-alert-dot" aria-hidden="true"></span>
          <p>${escapeHtml(billAlertText(alert))}</p>
        </div>`).join('')}
    </div>
    ${alerts.length > shown.length
      ? `<p class="hint bill-alert-more">${alerts.length - shown.length} more alert${alerts.length - shown.length === 1 ? '' : 's'}</p>`
      : ''}`;
}

function trendMonthLabel(date) {
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime())
    ? String(date).slice(5)
    : parsed.toLocaleDateString(undefined, { month: 'short' });
}

function billTrendChart(trend, provider) {
  const width = 320;
  const height = 116;
  const chartHeight = 76;
  const gap = 8;
  const barWidth = (width - gap * (trend.points.length - 1)) / trend.points.length;
  const max = Math.max(...trend.points.map(point => point.value), 1);
  const bars = trend.points.map((point, index) => {
    const barHeight = Math.max(5, (point.value / max) * chartHeight);
    const x = index * (barWidth + gap);
    const y = chartHeight - barHeight;
    return `<g>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="4"></rect>
      <text x="${(x + barWidth / 2).toFixed(1)}" y="108" text-anchor="middle">${escapeHtml(trendMonthLabel(point.dueDate))}</text>
    </g>`;
  }).join('');
  const metric = trend.metric === 'usage' ? `${trend.unit} usage` : 'bill cost';
  return `<svg class="bill-trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(provider)} ${escapeHtml(metric)} trend">${bars}</svg>`;
}

function renderBillTrends(bills, accounts) {
  const container = $('billTrends');
  const trends = accounts
    .filter(account => !account.deleted)
    .map(account => ({ account, trend: window.TillRollBills.buildBillTrend(bills, account.id, today()) }))
    .filter(item => item.trend);

  $('billTrendsHead').hidden = !trends.length;
  if (!trends.length) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = trends.map(({ account, trend }) => {
    const type = BILL_TYPE_LABELS[account.utility_type] || 'Other';
    const metricValue = trend.metric === 'usage'
      ? `${Number(trend.average.toFixed(2)).toLocaleString()} ${escapeHtml(trend.unit)} average`
      : `${money(Math.round(trend.average))} average`;
    const change = trend.changePercent === null
      ? ''
      : `<span class="bill-trend-change ${trend.changePercent > 0 ? 'up' : 'down'}">${trend.changePercent > 0 ? '+' : ''}${Math.round(trend.changePercent)}%</span>`;
    return `
      <article class="card bill-trend-card">
        <div class="bill-trend-head">
          <div>
            <span class="eyebrow">${escapeHtml(type)}</span>
            <h3>${escapeHtml(account.name)}</h3>
          </div>
          ${change}
        </div>
        <p class="bill-trend-summary">${metricValue}${trend.typicalAmountCents === null ? '' : ` · typical bill ${escapeHtml(money(Math.round(trend.typicalAmountCents)))}`}</p>
        ${billTrendChart(trend, account.name)}
      </article>`;
  }).join('');
}

async function renderBills() {
  await ensureScheduledBills(state.month);
  const [allBills, accounts] = await Promise.all([live('bills'), live('bill_accounts')]);
  const accountById = Object.fromEntries(accounts.map(a => [a.id, a]));
  const currentMonthBills = allBills.filter(b => b.month === state.month);
  const overdueBills = allBills.filter(b =>
    b.status !== 'paid' && b.due_date < today() && b.month !== state.month
  );
  const visible = [...currentMonthBills, ...overdueBills]
    .filter((bill, index, list) => list.findIndex(other => other.id === bill.id) === index)
    .sort((a, b) => {
      if ((a.status === 'paid') !== (b.status === 'paid')) return a.status === 'paid' ? 1 : -1;
      return a.due_date.localeCompare(b.due_date);
    });

  const due = currentMonthBills.filter(b => b.status !== 'paid').reduce((sum, b) => sum + b.amount, 0);
  const paid = currentMonthBills.filter(b => b.status === 'paid').reduce((sum, b) => sum + b.amount, 0);
  $('billsDue').textContent = money(due);
  $('billsPaid').textContent = money(paid);
  $('billsOverdue').textContent = String(allBills.filter(b => b.status !== 'paid' && b.due_date < today()).length);
  $('billCount').textContent = visible.length ? `${visible.length} shown` : '';
  renderBillAlerts(allBills, accounts);
  renderBillTrends(allBills, accounts);

  const list = $('billList');
  if (!visible.length) {
    list.innerHTML = '<div class="blank">No bills in this month. Add one above or move to another month.</div>';
    return;
  }

  list.innerHTML = visible.map(bill => {
    const account = accountById[bill.account_id];
    if (!account) return '';
    const timing = window.TillRollBills.billTiming(bill, today());
    const type = BILL_TYPE_LABELS[account.utility_type] || 'Other';
    const usage = bill.usage === null || bill.usage === undefined
      ? ''
      : ` · ${escapeHtml(bill.usage)} ${escapeHtml(bill.usage_unit || 'units')}`;
    const reference = maskedAccountReference(account.account_reference);
    const recurrence = window.TillRollBills.recurrenceLabel(account.recurrence);

    return `
      <article class="card bill-card ${timing}">
        <div class="bill-head">
          <div class="meta">
            <span class="bill-status ${timing}">${billStatusLabel(timing)}</span>
            <h3>${escapeHtml(account.name)}</h3>
            <p>${escapeHtml(type)} · due ${escapeHtml(dayLabel(bill.due_date))}${usage}</p>
            <p>${escapeHtml(recurrence)}${reference ? ` · Account ${escapeHtml(reference)}` : ''}</p>
          </div>
          <strong class="bill-amount">${escapeHtml(money(bill.amount))}</strong>
        </div>
        <div class="bill-actions">
          ${bill.status !== 'paid'
            ? `<button class="primary compact" type="button" onclick="markBillPaid('${bill.id}')">Mark paid</button>
               <button class="ghost compact" type="button" onclick="editBill('${bill.id}')">Update</button>`
            : `<span class="bill-paid-note">Paid ${escapeHtml(dayLabel(bill.paid_date))}</span>`}
          ${bill.has_document
            ? `<button class="ghost compact" type="button" onclick="openBillDocument('${bill.id}')">View bill</button>`
            : ''}
          ${account.active && account.recurrence !== 'once'
            ? `<button class="ghost compact" type="button" onclick="stopBillRecurrence('${account.id}')">Stop repeating</button>`
            : ''}
          <button class="del" type="button" onclick="deleteBill('${bill.id}')" aria-label="Delete bill">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.021-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/></svg>
          </button>
        </div>
      </article>`;
  }).join('');
}
