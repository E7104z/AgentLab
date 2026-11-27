// PDF lead-list extraction.
//
// Government vendor directories (county SLBE/LSBE lists, UCP exports) are
// tables printed to PDF. Each business is one "record" whose cells may wrap
// onto several lines ABOVE and BELOW the line that holds its phone number,
// because the PDF engine vertically centers each cell.
//
// Strategy (deterministic, no AI needed):
//   1. Pull every text item with its x/y position (pdfjs-dist).
//   2. Find the header row (the line with the most known header words) and
//      take each header cell's x-position as a column start.
//   3. Anchor each record on a phone number. Every other text item is
//      assigned to the nearest phone anchor vertically (same page).
//   4. Inside a record, drop each item into a column by x-position, then map
//      column headers to lead fields.
// If no usable header/anchors are found, the caller can fall back to the
// Claude-based extractor (see import.js).

const PHONE_RE = /\(?\b\d{3}\)?[\s.\-]*\d{3}[\s.\-]+\d{4}\b/;
const PHONE_RE_G = /\(?\b\d{3}\)?[\s.\-]*\d{3}[\s.\-]+\d{4}\b/g;
const EMAIL_RE_G = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

const HEADER_WORDS = [
  'business', 'name', 'company', 'title', 'vendor', 'firm', 'address', 'contact',
  'phone', 'telephone', 'email', 'e-mail', 'city', 'state', 'zip', 'county',
  'naics', 'nigp', 'description', 'type', 'expiration', 'certification', 'owner', 'website'
];

// Header cells can sit ~1 space apart; only merge items closer than a space.
const HEADER_GAP = 0.28;
const NAME_LABEL_RE = /(business|company|firm|vendor)\s*name|^name$|^title$|^business$|^company$|^firm$|^vendor$|legal name/i;

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function readItems(buffer) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      const str = (it.str || '').trim();
      if (!str) continue;
      items.push({ str, x: it.transform[4], y: it.transform[5], w: it.width || 0, h: Math.abs(it.transform[3]) || 8 });
    }
    pages.push(items);
  }
  return pages;
}

// Group items into visual lines (same baseline within tolerance), top to bottom.
function toLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const line = lines.find(l => Math.abs(l.y - it.y) <= Math.max(2, it.h * 0.35));
    if (line) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

// Merge horizontally adjacent items on one line into phrases (cells).
function phrases(lineItems, gapFactor = 0.9) {
  const out = [];
  for (const it of lineItems) {
    const last = out[out.length - 1];
    if (last && it.x - (last.x + last.w) < Math.max(3, it.h * gapFactor)) {
      last.str += ' ' + it.str;
      last.w = it.x + it.w - last.x;
    } else {
      out.push({ ...it });
    }
  }
  return out;
}

function headerScore(text) {
  const t = text.toLowerCase();
  return HEADER_WORDS.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
}

// Header labels sometimes span 2-3 stacked lines ("Expiration" / "Date").
// Look at the best-scoring line plus the lines just above/below it and merge
// phrases that sit in the same column.
function findHeader(pages) {
  let best = null;
  pages.slice(0, 3).forEach((items, pageIdx) => {
    const lines = toLines(items);
    lines.forEach((l, i) => {
      const ph = phrases(l.items, HEADER_GAP);
      if (ph.length < 3) return;
      const score = ph.reduce((n, p) => n + (headerScore(p.str) > 0 ? 1 : 0), 0);
      if (score >= 3 && (!best || score > best.score)) best = { score, pageIdx, lineIdx: i, lines, y: l.y };
    });
  });
  if (!best) return null;

  const band = best.lines.filter(l => Math.abs(l.y - best.y) <= 22);
  const cells = [];
  for (const l of band) {
    for (const p of phrases(l.items, HEADER_GAP)) {
      if (PHONE_RE.test(p.str)) continue;
      const overlap = cells.find(c => p.x < c.x + c.w + 6 && p.x + p.w > c.x - 6);
      if (overlap) {
        const top = l.y > overlap.y;
        overlap.label = top ? p.str + ' ' + overlap.label : overlap.label + ' ' + p.str;
        const nx = Math.min(overlap.x, p.x);
        overlap.w = Math.max(overlap.x + overlap.w, p.x + p.w) - nx;
        overlap.x = nx;
        if (top) overlap.y = l.y;
      } else {
        cells.push({ label: p.str, x: p.x, w: p.w, y: l.y });
      }
    }
  }
  cells.sort((a, b) => a.x - b.x);
  const headerYTop = Math.max(...band.map(l => l.y));
  const headerYBottom = Math.min(...band.map(l => l.y));
  return { columns: cells.map(c => ({ label: c.label.replace(/\s+/g, ' ').trim(), x: c.x, w: c.w })), pageIdx: best.pageIdx, headerYTop, headerYBottom };
}

// Column for an item: the column whose span (start..start+width) contains the
// item's center, else the nearest column center. Headers are often centered over
// wider data, so "nearest center" is more reliable than "last start to the left".
function columnFor(columns, item) {
  const cx = item.x + item.w / 2;
  let bestIdx = 0, bestDist = Infinity;
  columns.forEach((c, i) => {
    const center = c.x + c.w / 2;
    const inside = cx >= c.x - 4 && cx <= c.x + c.w + 4;
    const d = inside ? 0 : Math.abs(cx - center);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  });
  return bestIdx;
}

function isRepeatedHeaderOrFooter(text) {
  const t = text.toLowerCase();
  return headerScore(t) >= 3 || /^page \d+/.test(t) || /\bpage \d+ of \d+\b/.test(t);
}

/**
 * Returns { ok, columns, records: [{ cells: {label: text}, text }] }.
 * Record cells keep the raw header labels so import.js can map them.
 */
async function extractPdfTable(buffer) {
  const pages = await readItems(buffer);
  const header = findHeader(pages);
  if (!header) return { ok: false, reason: 'No table header found', pages: pages.length };
  const { columns } = header;

  const records = [];
  pages.forEach((items, pageIdx) => {
    let body = items;
    if (pageIdx === header.pageIdx) body = items.filter(it => it.y < header.headerYBottom - 2);
    // Drop repeated header bands on later pages.
    const lines = toLines(body).filter(l => !isRepeatedHeaderOrFooter(l.items.map(i => i.str).join(' ')));
    const kept = lines.flatMap(l => l.items);

    // Phone anchors: one per record. A record may print a second number
    // (cell/fax) on the next line; that line has no business-name text, so it
    // is folded into the record above instead of starting a new one.
    const nameCol = columns.findIndex(c => NAME_LABEL_RE.test(c.label));
    const anchors = [];
    for (const l of lines) {
      const lineText = l.items.map(i => i.str).join(' ');
      if (/\bfax\b/i.test(lineText) && !l.items.some(i => nameCol >= 0 && columnFor(columns, i) === nameCol)) continue;
      for (const it of l.items) {
        if (!PHONE_RE.test(it.str)) continue;
        const col = columnFor(columns, it);
        const hasName = nameCol >= 0 && l.items.some(i => columnFor(columns, i) === nameCol);
        const dup = anchors.find(a => a.col === col && Math.abs(a.y - it.y) < it.h * 1.6);
        if (dup && !(hasName && dup.hasName)) continue;
        if (anchors.some(a => Math.abs(a.y - it.y) < 2)) continue; // two numbers on one line
        anchors.push({ y: it.y, col, hasName });
      }
    }
    if (!anchors.length) return;
    anchors.sort((a, b) => b.y - a.y);

    // Cells may be vertically centered (wrapped text above AND below the
    // phone line), bottom-aligned (all wrapped text above) or top-aligned.
    // Try each and keep the one that yields the cleanest records.
    let best = null;
    for (const mode of ['center', 'bottom', 'top']) {
      const built = buildRecords(kept, anchors, columns, mode, nameCol);
      const penalty = scoreRecords(built, columns, nameCol);
      if (!best || penalty < best.penalty) best = { penalty, built };
    }
    records.push(...best.built);
  });

  return { ok: records.length > 0, columns: columns.map(c => c.label), records, pages: pages.length };
}

function assignAnchor(it, anchors, mode) {
  const tol = Math.max(3, it.h * 0.4);
  if (mode === 'center') {
    let best = null, bestD = Infinity;
    for (const a of anchors) { const d = Math.abs(a.y - it.y); if (d < bestD) { bestD = d; best = a; } }
    return bestD < 70 ? best : null;
  }
  if (mode === 'bottom') {
    // first anchor at or below the item (anchors sorted top -> bottom)
    const a = anchors.find(a => a.y <= it.y + tol);
    return a && it.y - a.y < 400 ? a : null;
  }
  // top-aligned: last anchor at or above the item
  let found = null;
  for (const a of anchors) if (a.y >= it.y - tol) found = a;
  return found && found.y - it.y < 400 ? found : null;
}

function buildRecords(items, anchors, columns, mode, nameCol) {
  const buckets = anchors.map(() => []);
  const owner = new Map();
  for (const it of items) {
    const a = assignAnchor(it, anchors, mode);
    if (a) { buckets[anchors.indexOf(a)].push(it); owner.set(it, a); }
  }
  const recs = buckets.map(bucket => {
    const cellItems = columns.map(() => []);
    for (const it of bucket) cellItems[columnFor(columns, it)].push(it);
    const cells = {};
    columns.forEach((c, i) => {
      const its = cellItems[i].sort((p, q) => q.y - p.y || p.x - q.x);
      const parts = [];
      let lastY = null;
      for (const it of its) {
        if (lastY !== null && Math.abs(lastY - it.y) > 2) parts.push('\n');
        else if (parts.length) parts.push(' ');
        parts.push(it.str);
        lastY = it.y;
      }
      cells[c.label] = parts.join('').replace(/ *\n */g, '\n').trim();
    });
    return { cells, text: Object.values(cells).join('\n') };
  });
  recs.splitPenalty = splitRunPenalty(items, anchors, columns, owner);
  return recs;
}

// A wrapped cell is a run of lines in one column with normal line spacing.
// Splitting a run between two records is wrong unless a record's anchor line
// sits between those two lines (that is where one row ends and the next begins).
function splitRunPenalty(items, anchors, columns, owner) {
  let pen = 0;
  const byCol = columns.map(() => []);
  for (const it of items) byCol[columnFor(columns, it)].push(it);
  for (const col of byCol) {
    col.sort((a, b) => b.y - a.y);
    for (let i = 1; i < col.length; i++) {
      const a = col[i - 1], b = col[i];
      if (a.y - b.y > Math.max(a.h, b.h) * 1.6 || a.y - b.y < 2) continue;
      const oa = owner.get(a), ob = owner.get(b);
      if (!oa || !ob || oa === ob) continue;
      const tol = Math.max(3, b.h * 0.4);
      const boundary = anchors.some(x => x.y > b.y + tol && x.y < a.y + tol);
      if (!boundary) pen += 1;
    }
  }
  return pen;
}

// Lower is better: records that swallowed a neighbour show 2+ emails, 2+
// distinct phones, or an empty / many-line business name.
function scoreRecords(records, columns, nameCol) {
  let pen = records.splitPenalty || 0;
  for (const r of records) {
    const emails = new Set((r.text.match(EMAIL_RE_G) || []).map(e => e.toLowerCase()));
    const phones = new Set((r.text.match(PHONE_RE_G) || []).map(p => p.replace(/\D/g, '')));
    if (emails.size > 1) pen += 2;
    if (phones.size > 2) pen += 2;
    if (nameCol >= 0) {
      const name = r.cells[columns[nameCol].label] || '';
      if (!name) pen += 3;
      else if (name.split('\n').length > 3) pen += 1;
    }
  }
  return pen;
}

// Plain text of the whole PDF, line by line (used by the AI fallback).
async function extractPdfText(buffer) {
  const pages = await readItems(buffer);
  return pages.map(items => toLines(items).map(l => phrases(l.items).map(p => p.str).join('   |   ')).join('\n'));
}

module.exports = { extractPdfTable, extractPdfText, PHONE_RE_G, EMAIL_RE_G };
