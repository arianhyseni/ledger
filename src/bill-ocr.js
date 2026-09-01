const DATE_LABEL = /(?:due\s*date|payment\s*due|pay\s*by|fizetési\s*határidő|esedékesség|határidő)/i;
const STRONG_AMOUNT_LABEL = /(?:amount\s*due|total\s*due|balance\s*due|grand\s*total|fizetendő(?:\s*összeg)?|végösszeg)/i;
const TOTAL_AMOUNT_LABEL = /(?:\btotal\b|összesen)/i;
const ACCOUNT_LABEL = /(?:account\s*(?:number|reference|no\.?|id)|customer\s*(?:number|reference|no\.?|id)|contract\s*account|ügyfélazonosító|vevőazonosító|felhasználó\s*azonosító|szerződésszám)/i;
const PROVIDER_LABEL = /(?:provider|supplier|service\s*provider|szolgáltató|kibocsátó)/i;
const USAGE_LABEL = /(?:consumption|usage|metered|fogyasztás|felhasználás)/i;
const MONEY_NUMBER = /\d{1,3}(?:[ .,'’]\d{3})*(?:[,.]\d{1,2})?|\d+(?:[,.]\d{1,2})?/g;
const DATE_VALUE = /\b(\d{4})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})(?:\.|\b)|\b(\d{1,2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{4})\b/;

function cleanLines(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
}

function validIsoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dateFromLine(line) {
  const match = DATE_VALUE.exec(line);
  if (!match) return null;
  return match[1]
    ? validIsoDate(Number(match[1]), Number(match[2]), Number(match[3]))
    : validIsoDate(Number(match[6]), Number(match[5]), Number(match[4]));
}

export function parseBillMoney(value) {
  let number = String(value || '')
    .replace(/[\s'’]/g, '')
    .replace(/[^\d,.-]/g, '');
  if (!number || !/\d/.test(number)) return null;

  const comma = number.lastIndexOf(',');
  const dot = number.lastIndexOf('.');
  const separator = Math.max(comma, dot);
  if (separator >= 0) {
    const decimals = number.length - separator - 1;
    const decimalSeparator = decimals > 0 && decimals <= 2 ? number[separator] : null;
    if (decimalSeparator) {
      const whole = number.slice(0, separator).replace(/[.,]/g, '');
      number = `${whole}.${number.slice(separator + 1)}`;
    } else {
      number = number.replace(/[.,]/g, '');
    }
  }

  const parsed = Number(number);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : null;
}

function amountFromLines(lines) {
  const ranked = [
    ...lines.filter(line => STRONG_AMOUNT_LABEL.test(line)),
    ...lines.filter(line => TOTAL_AMOUNT_LABEL.test(line) && !/subtotal/i.test(line)),
    ...lines.filter(line => /(?:\bHUF\b|\bEUR\b|\bUSD\b|\bFt\b|€|\$|£)/i.test(line))
  ].filter((line, index, list) => list.indexOf(line) === index);
  for (const line of ranked) {
    const values = line.match(MONEY_NUMBER) || [];
    for (const value of values.reverse()) {
      const amount = parseBillMoney(value);
      if (amount !== null) return amount;
    }
  }
  return null;
}

function valueAfterLabel(line, label) {
  const match = line.match(label);
  if (!match) return '';
  return line.slice(match.index + match[0].length).replace(/^\s*(?:[:#-]|no\.?)?\s*/i, '').trim();
}

function providerFromLines(lines) {
  for (const line of lines.slice(0, 20)) {
    const value = valueAfterLabel(line, PROVIDER_LABEL);
    if (value && /[\p{L}]/u.test(value)) return value.slice(0, 100);
  }
  const company = lines.slice(0, 20).find(line =>
    /\b(?:kft\.?|zrt\.?|nyrt\.?|ltd\.?|limited|gmbh|inc\.?|s\.a\.?)\b/i.test(line) &&
    /[\p{L}]{2}/u.test(line)
  );
  if (company) return company.slice(0, 100);

  const fallback = lines.slice(0, 8).find(line =>
    line.length >= 3 && line.length <= 80 && /[\p{L}]{3}/u.test(line) &&
    !/(?:invoice|utility bill|statement|számla|fizetendő|összeg|customer|ügyfél)/i.test(line)
  );
  return fallback ? fallback.slice(0, 100) : null;
}

function accountFromLines(lines) {
  for (const line of lines) {
    const value = valueAfterLabel(line, ACCOUNT_LABEL);
    const match = value.match(/[\p{L}\d][\p{L}\d /.-]{2,50}/u);
    if (match) return match[0].trim();
  }
  return null;
}

function usageFromLines(lines) {
  const candidates = lines.filter(line => USAGE_LABEL.test(line));
  for (const line of candidates) {
    const match = line.match(/(\d+(?:[.,]\d+)?)\s*(kWh|m[³3]|GB|units?|egység)/i);
    if (!match) continue;
    const usage = Number(match[1].replace(',', '.'));
    if (!Number.isFinite(usage)) continue;
    const rawUnit = match[2].toLowerCase();
    const usageUnit = rawUnit === 'kwh' ? 'kWh'
      : rawUnit === 'gb' ? 'GB'
        : rawUnit.startsWith('m') ? 'm³' : 'units';
    return { usage, usageUnit };
  }
  return { usage: null, usageUnit: null };
}

function utilityTypeFromText(text) {
  const rules = [
    ['electricity', /electric(?:ity| power)|villamos\s*energia|áram(?:díj|számla)?/i],
    ['water', /water|víz(?:díj|számla|művek)?/i],
    ['gas', /natural\s*gas|gas\s*bill|földgáz|gáz(?:díj|számla)?/i],
    ['internet', /internet|broadband|szélessáv/i],
    ['phone', /mobile|telephone|phone|telekommunikáció|telefon/i],
    ['rent', /rent|rental|bérleti\s*díj|lakbér/i],
    ['insurance', /insurance|biztosítás/i],
    ['subscription', /subscription|előfizetés/i]
  ];
  const match = rules.find(([, pattern]) => pattern.test(text));
  return match ? match[0] : null;
}

function currencyFromText(text) {
  if (/(?:\bHUF\b|\bFt\b)/i.test(text)) return 'HUF';
  if (/(?:\bEUR\b|€)/i.test(text)) return 'EUR';
  if (/(?:\bUSD\b|US\$|\$)/i.test(text)) return 'USD';
  if (/(?:\bGBP\b|£)/i.test(text)) return 'GBP';
  return null;
}

export function extractBillFields(text) {
  const lines = cleanLines(text);
  const labelledDue = lines.filter(line => DATE_LABEL.test(line));
  let dueDate = null;
  for (const line of labelledDue) {
    dueDate = dateFromLine(line);
    if (dueDate) break;
  }
  const usage = usageFromLines(lines);

  return {
    provider: providerFromLines(lines),
    amountCents: amountFromLines(lines),
    currency: currencyFromText(text),
    dueDate,
    accountReference: accountFromLines(lines),
    usage: usage.usage,
    usageUnit: usage.usageUnit,
    utilityType: utilityTypeFromText(text),
    rawText: lines.join('\n')
  };
}

let workerPromise = null;
let progressListener = null;

async function getOcrWorker(onProgress) {
  progressListener = onProgress;
  if (!workerPromise) {
    workerPromise = (async () => {
      const [{ createWorker }, workerUrl] = await Promise.all([
        import('tesseract.js'),
        import('tesseract.js/dist/worker.min.js?url')
      ]);
      const worker = await createWorker(['eng', 'hun'], 1, {
        workerPath: workerUrl.default,
        logger(message) {
          if (progressListener) progressListener(message);
        }
      });
      await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
      return worker;
    })().catch(error => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

async function canvasFromImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = longest < 1800 ? Math.min(2, 1800 / longest) : Math.min(1, 2600 / longest);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.filter = 'grayscale(1) contrast(1.25)';
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

async function readPdf(file, onProgress) {
  onProgress({ status: 'reading PDF', progress: 0.05 });
  const [pdfjs, workerUrl] = await Promise.all([
    import('pdfjs-dist/build/pdf.mjs'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;
  const documentTask = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const pdf = await documentTask.promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const embeddedText = content.items
    .map(item => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`)
    .join('')
    .trim();
  if (embeddedText.replace(/\s/g, '').length >= 60) {
    await pdf.destroy();
    return { text: embeddedText, source: 'pdf-text' };
  }

  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d', { alpha: false });
  await page.render({ canvasContext: context, viewport }).promise;
  await pdf.destroy();
  return { canvas, source: 'pdf-ocr' };
}

export async function scanBillDocument(file, { onProgress = () => {} } = {}) {
  if (!(file instanceof Blob)) throw new TypeError('Choose an image or PDF bill.');
  if (file.size > 15 * 1024 * 1024) throw new Error('Bill files must be 15 MB or smaller.');

  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
  const pdfResult = isPdf ? await readPdf(file, onProgress) : null;
  if (pdfResult && pdfResult.text) {
    onProgress({ status: 'reading embedded text', progress: 1 });
    return { ...extractBillFields(pdfResult.text), source: pdfResult.source };
  }

  const image = pdfResult ? pdfResult.canvas : await canvasFromImage(file);
  const worker = await getOcrWorker(onProgress);
  const result = await worker.recognize(image, { rotateAuto: true }, { text: true });
  return { ...extractBillFields(result.data.text), source: pdfResult ? pdfResult.source : 'image-ocr' };
}
