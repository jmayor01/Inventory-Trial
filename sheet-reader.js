'use strict';

// Reads spreadsheets in the browser, with no outside library:
//   readWorkbook(file) -> [{ name, rows }]   rows are arrays of cell text
// It understands Excel .xlsx files (a zip of XML) and .csv files. Only cell
// values are read; formulas come through as the value Excel last worked out.

const SHEET_MAX_FILE_BYTES = 10 * 1024 * 1024;
const SHEET_MAX_PART_BYTES = 40 * 1024 * 1024; // one unpacked part of the zip

/** Splits CSV text into rows of cells, honouring quotes. Blank rows are dropped. */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

/** The files inside a zip, as a map from name to a function that unpacks it. */
function zipEntries(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  // The directory of the zip sits at the end, after an "end of directory" record.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('not a zip');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new Error('damaged zip');
    const method = view.getUint16(at + 10, true);
    const packedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.set(name, async () => {
      if (size > SHEET_MAX_PART_BYTES) throw new Error('too big');
      const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
      const packed = bytes.subarray(dataAt, dataAt + packedSize);
      if (method === 0) return packed;
      if (method !== 8) throw new Error('unsupported zip method');
      const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function xmlOf(bytes) {
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('damaged xml');
  return doc;
}

const tags = (node, name) => [...node.getElementsByTagNameNS('*', name)];

/** "C7" -> 2 (the column index of a cell reference). */
function columnIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

async function readXlsx(buffer) {
  const entries = zipEntries(buffer);
  const part = async (name) => {
    const get = entries.get(name);
    return get ? xmlOf(await get()) : null;
  };

  const workbook = await part('xl/workbook.xml');
  const rels = await part('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw new Error('not an excel file');
  const targetOf = new Map(tags(rels, 'Relationship').map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]));

  // Text cells point into one shared list of strings.
  const shared = [];
  const sst = await part('xl/sharedStrings.xml');
  if (sst) {
    for (const si of tags(sst, 'si')) {
      // Skip phonetic guides (rPh), which are not part of the visible text.
      shared.push(tags(si, 't').filter((t) => t.parentNode.localName !== 'rPh').map((t) => t.textContent).join(''));
    }
  }

  const sheets = [];
  for (const sheet of tags(workbook, 'sheet')) {
    const relId = sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || sheet.getAttribute('r:id');
    let target = targetOf.get(relId) || '';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const doc = await part(target);
    if (!doc) continue; // e.g. a chart sheet
    const rows = [];
    for (const row of tags(doc, 'row')) {
      const cells = [];
      let next = 0;
      for (const c of tags(row, 'c')) {
        const ref = c.getAttribute('r');
        const col = ref ? columnIndex(ref) : next;
        next = col + 1;
        const type = c.getAttribute('t');
        const v = tags(c, 'v')[0];
        let text = '';
        if (type === 'inlineStr') text = tags(c, 't').map((t) => t.textContent).join('');
        else if (!v) text = '';
        else if (type === 's') text = shared[Number(v.textContent)] ?? '';
        else if (type === 'e') text = ''; // an error such as #DIV/0!
        else if (type === 'b') text = v.textContent === '1' ? 'TRUE' : 'FALSE';
        else text = v.textContent; // a number, or the text result of a formula
        if (col >= 0 && col < 2000) cells[col] = text;
      }
      const rowNumber = Number(row.getAttribute('r')) || rows.length + 1;
      if (rowNumber <= 200000) rows[rowNumber - 1] = Array.from(cells, (x) => x ?? '');
    }
    sheets.push({ name: sheet.getAttribute('name') || `Sheet ${sheets.length + 1}`, rows: Array.from(rows, (r) => r ?? []) });
  }
  if (!sheets.length) throw new Error('no sheets');
  return sheets;
}

/** Reads an .xlsx or .csv File into [{ name, rows }]. Throws an Error with a readable message. */
async function readWorkbook(file) {
  if (file.size > SHEET_MAX_FILE_BYTES) throw new Error('That file is too big (over 10 MB).');
  const name = file.name.toLowerCase();
  if (name.endsWith('.xls')) throw new Error('This is an old-style .xls file. Open it in Excel, choose Save As, pick "Excel Workbook (.xlsx)", and import that.');
  const buffer = await file.arrayBuffer();
  const head = new Uint8Array(buffer.slice(0, 4));
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  if (isZip) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open Excel files. Update the browser, or save the sheet as CSV and import that.');
    try {
      return await readXlsx(buffer);
    } catch {
      throw new Error('This Excel file could not be read. Save it again as "Excel Workbook (.xlsx)" or as CSV and try once more.');
    }
  }
  const rows = parseCsv(new TextDecoder().decode(buffer));
  if (!rows.length) throw new Error('That file is empty.');
  return [{ name: 'CSV', rows }];
}
