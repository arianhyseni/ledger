const DATE_LABEL = /(?:due\s*date|payment\s*due|pay\s*by|afati\s*(?:i|për|per)?\s*pages[ëe]s|data\s*e\s*pages[ëe]s|paguaj\s*deri|rok\s*(?:za\s*)?pla[ćc]anja|datum\s*dospe[ćc]a|dospije[ćc]e|рок\s*(?:за\s*)?плаћања|датум\s*доспећа|fizetési\s*határidő|esedékesség|határidő)/i;
const STRONG_AMOUNT_LABEL = /(?:amount\s*due|total\s*due|balance\s*due|grand\s*total|shuma\s*(?:për|per)\s*pages[ëe]|shuma\s*e\s*fatur[ëe]s|fatura\s*e\s*tanishme|p[ëe]r\s*pages[ëe]|iznos\s*(?:za\s*)?pla[ćc]anje|ukupan\s*iznos|za\s*uplatu|износ\s*(?:за\s*)?плаћање|укупан\s*износ|за\s*уплату|fizetendő(?:\s*összeg)?|végösszeg)/i;
const TOTAL_AMOUNT_LABEL = /(?:\btotal\b|\btotali\b|\bshuma\b|\bbilanci\b|\bukupno\b|\bсвега\b|\bукупно\b|összesen)/i;
const ACCOUNT_LABEL = /(?:account\s*(?:number|reference|no\.?|id)|customer\s*(?:number|reference|no\.?|id)|contract\s*account|id\s*e\s*konsumatorit|shifra\s*e\s*konsumatorit|numri\s*(?:personal\s*)?(?:i\s*)?konsumatorit|kodi\s*(?:i\s*)?konsumatorit|numri\s*i\s*referenc[ëe]s(?:\s*s[ëe]\s*pages[ëe]s)?|barkodi\s*i\s*fatur[ëe]s|broj\s*(?:kupca|potrošača|potrosaca|računa|racuna)|šifra\s*(?:kupca|potrošača)|sifra\s*(?:kupca|potrosaca)|poziv\s*na\s*broj|број\s*(?:купца|потрошача|рачуна)|шифра\s*(?:купца|потрошача)|позив\s*на\s*број|ügyfélazonosító|vevőazonosító|felhasználó\s*azonosító|szerződésszám)/i;
const PROVIDER_LABEL = /(?:provider|supplier|service\s*provider|ofruesi|furnizuesi|l[ëe]shuesi|dobavlja[čc]|pružalac\s*usluge|pruzalac\s*usluge|добављач|пружалац\s*услуге|szolgáltató|kibocsátó)/i;
const USAGE_LABEL = /(?:consumption|usage|metered|konsumi|konsum(?:i|uar)|energjia\s*e\s*konsumuar|potrošnja|potrosnja|потрошња|fogyasztás|felhasználás)/i;
const MONEY_NUMBER = /\d{1,3}(?:[ .,'’]\d{3})*(?:[,.]\d{1,2})?|\d+(?:[,.]\d{1,2})?/g;
const DATE_VALUE = /\b(\d{4})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})(?:\.|\b)|\b(\d{1,2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{4})\b/;
const CURRENCY_LABEL = /(?:\bEUR\b|€|\bRSD\b|\bdin\.?\b|\bHUF\b|\bFt\b|\bUSD\b|\bGBP\b|\$|£)/i;
const ANY_FIELD_LABEL = new RegExp([
  DATE_LABEL.source, STRONG_AMOUNT_LABEL.source, ACCOUNT_LABEL.source,
  PROVIDER_LABEL.source, USAGE_LABEL.source
].join('|'), 'i');

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
  const match = DATE_VALUE.exec(String(line).replace(/[Oo]/g, '0'));
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
  const ranked = [];
  lines.forEach((line, index) => {
    if (STRONG_AMOUNT_LABEL.test(line)) {
      ranked.push(line);
      for (const nearby of lines.slice(index + 1, index + 3)) {
        if (ANY_FIELD_LABEL.test(nearby)) break;
        if (CURRENCY_LABEL.test(nearby) || /^\s*\d[\d .,'’]*(?:[,.]\d{1,2})?\s*$/.test(nearby)) ranked.push(nearby);
      }
    }
  });
  ranked.push(
    ...lines.filter(line => TOTAL_AMOUNT_LABEL.test(line) && !/(?:subtotal|n[ëe]ntotal|međuzbir|medjuzbir)/i.test(line)),
    ...lines.filter(line => CURRENCY_LABEL.test(line))
  );
  const unique = ranked.filter((line, index, list) => list.indexOf(line) === index);
  for (const line of unique) {
    if (dateFromLine(line) && !CURRENCY_LABEL.test(line)) continue;
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
  const knownProvider = lines.slice(0, 30).find(line =>
    /\b(?:KESCO(?:\s+Energy)?|KEDS|KRU\s+[\p{L} .'-]+|Termokos)\b/iu.test(line)
  );
  if (knownProvider) {
    const match = knownProvider.match(/\b(?:KESCO(?:\s+Energy)?|KEDS|KRU\s+[\p{L} .'-]+|Termokos)\b/iu);
    if (match) return match[0].trim().slice(0, 100);
  }
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
    !/(?:invoice|utility bill|statement|fatur[ae]|pages[ëe]|konsumator|energji(?:a|e)|račun|racun|плаћање|рачун|számla|fizetendő|összeg|customer|ügyfél)/i.test(line)
  );
  return fallback ? fallback.slice(0, 100) : null;
}

function accountFromLines(lines) {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const value = valueAfterLabel(line, ACCOUNT_LABEL);
    const match = value.match(/[\p{L}\d][\p{L}\d /.-]{2,50}/u);
    if (match) return match[0].trim();
    if (!ACCOUNT_LABEL.test(line)) continue;
    for (const nearby of lines.slice(index + 1, index + 3)) {
      if (ANY_FIELD_LABEL.test(nearby)) break;
      const nearbyMatch = nearby.match(/\b[\p{L}\d][\p{L}\d/.-]{3,50}\b/u);
      if (nearbyMatch) return nearbyMatch[0].trim();
    }
  }
  return null;
}

function usageFromLines(lines) {
  const candidates = [];
  lines.forEach((line, index) => {
    if (!USAGE_LABEL.test(line)) return;
    candidates.push(line, ...lines.slice(index + 1, index + 3));
  });
  for (const line of candidates) {
    const match = line.match(/(\d+(?:[.,]\d+)?)\s*(kWh|kW|m[³3]|GB|units?|nj[ëe]si|jedinica|јединица|egység)/i);
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
    ['electricity', /electric(?:ity| power)|energji(?:a|e|s[ëe])?\s*elektrike|rrym[ëe]|elektri[čc]n[ae]\s*energij[ae]|struj[ae]|електричн[\p{L}]*\s*енергиј[\p{L}]*|струј[ае]|villamos\s*energia|áram(?:díj|számla)?/iu],
    ['water', /water|uj[ëe]sjell[ëe]s|fatur[ae]\s*e\s*ujit|potrošnj[ae]\s*vode|račun\s*za\s*vodu|вода|водовод|víz(?:díj|számla|művek)?/i],
    ['gas', /natural\s*gas|gas\s*bill|gaz(?:i|it)|plin|gas|гас|földgáz|gáz(?:díj|számla)?/i],
    ['internet', /internet|broadband|brez\s+i\s+gjer[ëe]|širokopojasni|sirokopojasni|широкопојасни|szélessáv/i],
    ['phone', /mobile|telephone|phone|telefon|telefoni|mobilni|мобилни|телефон|telekommunikáció/i],
    ['rent', /rent|rental|qira|kirija|закуп|bérleti\s*díj|lakbér/i],
    ['insurance', /insurance|sigurim|osiguranje|осигурање|biztosítás/i],
    ['subscription', /subscription|abonim|pretplata|претплата|előfizetés/i]
  ];
  const match = rules.find(([, pattern]) => pattern.test(text));
  return match ? match[0] : null;
}

function currencyFromText(text) {
  if (/(?:\bRSD\b|\bdin\.?\b|дин\.?)/i.test(text)) return 'RSD';
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
    const index = lines.indexOf(line);
    dueDate = dateFromLine([line, ...lines.slice(index + 1, index + 3)].join(' '));
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
      const worker = await createWorker(['sqi', 'eng', 'srp', 'srp_latn'], 1, {
        workerPath: workerUrl.default,
        logger(message) {
          if (progressListener) progressListener(message);
        }
      });
      await worker.setParameters({
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
        tessedit_pageseg_mode: '3'
      });
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

function thresholdCanvas(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  context.drawImage(source, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const histogram = new Uint32Array(256);
  for (let index = 0; index < image.data.length; index += 4) histogram[image.data[index]]++;

  const pixelCount = canvas.width * canvas.height;
  let total = 0;
  for (let value = 0; value < 256; value++) total += value * histogram[value];
  let backgroundWeight = 0;
  let backgroundTotal = 0;
  let bestVariance = -1;
  let threshold = 170;
  for (let value = 0; value < 256; value++) {
    backgroundWeight += histogram[value];
    if (!backgroundWeight) continue;
    const foregroundWeight = pixelCount - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundTotal += value * histogram[value];
    const backgroundMean = backgroundTotal / backgroundWeight;
    const foregroundMean = (total - backgroundTotal) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = value;
    }
  }

  // A small lift keeps thin letter strokes that a strict global threshold can
  // erase on phone photos with uneven lighting.
  threshold = Math.min(220, threshold + 12);
  for (let index = 0; index < image.data.length; index += 4) {
    const value = image.data[index] <= threshold ? 0 : 255;
    image.data[index] = value;
    image.data[index + 1] = value;
    image.data[index + 2] = value;
    image.data[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

export function pdfTextFromItems(items) {
  const positioned = items.filter(item =>
    item && String(item.str || '').trim() && Array.isArray(item.transform) && item.transform.length >= 6
  );
  if (positioned.length < Math.max(2, items.length / 2)) {
    return items.map(item => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`).join('').trim();
  }

  const rows = [];
  for (const item of positioned) {
    const y = Number(item.transform[5]);
    const x = Number(item.transform[4]);
    let row = rows.find(candidate => Math.abs(candidate.y - y) <= 3);
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push({ x, text: String(item.str || '').trim() });
  }

  return rows
    .sort((a, b) => b.y - a.y)
    .map(row => row.items.sort((a, b) => a.x - b.x).map(item => item.text).join(' ').trim())
    .filter(Boolean)
    .join('\n');
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
  const embeddedText = pdfTextFromItems(content.items);
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
  let text = result.data.text;
  let fields = extractBillFields(text);
  const coreFieldCount = [fields.provider, fields.amountCents, fields.dueDate, fields.accountReference]
    .filter(value => value !== null && value !== '').length;

  // Utility invoices frequently place labels and values in separate bordered
  // cells. A sparse-text retry recovers isolated values that normal page
  // segmentation can skip, but only pays the extra OCR cost when needed.
  if (coreFieldCount < 3) {
    onProgress({ status: 'reading boxed fields', progress: 0.82 });
    const thresholded = thresholdCanvas(image);
    let sparse;
    try {
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      sparse = await worker.recognize(thresholded, { rotateAuto: true }, { text: true });
    } finally {
      await worker.setParameters({ tessedit_pageseg_mode: '3' });
    }
    text = `${text}\n${sparse.data.text}`;
    fields = extractBillFields(text);
  }

  return { ...fields, source: pdfResult ? pdfResult.source : 'image-ocr' };
}
