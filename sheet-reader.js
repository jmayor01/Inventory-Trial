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

// ---------- Writing an Excel file ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Packs { name: text } into a zip (stored, not compressed). Returns a Uint8Array. */
function makeZip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const directory = [];
  let offset = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // names are UTF-8
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    directory.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directorySize = directory.reduce((n, part) => n + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...directory, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of all) { out.set(part, at); at += part.length; }
  return out;
}

const xmlText = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''); // characters XML does not allow

/** 0 -> "A", 27 -> "AB". */
function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

// Cell looks used by makeXlsx (indexes into the styles it writes).
const XLSX_STYLE = { plain: 0, title: 1, header: 2, text: 3, number: 4, money: 5 };

/**
 * Builds an .xlsx file with one sheet.
 *   rows   - arrays of cells; a cell is null (empty) or
 *            { text } | { number } | { formula, number } plus an optional `style`
 *   widths - column widths in characters
 *   merges - ranges such as "A1:G1"
 * Returns a Blob.
 */
function makeXlsx({ sheetName, rows, widths = [], merges = [], currency = '' }) {
  const sheetRows = rows.map((cells, r) => {
    const body = cells.map((cell, c) => {
      const ref = `${columnName(c)}${r + 1}`;
      if (!cell) return '';
      const style = ` s="${cell.style ?? 0}"`;
      if (cell.formula !== undefined) {
        const value = cell.number == null ? '' : `<v>${cell.number}</v>`;
        return `<c r="${ref}"${style}><f>${xmlText(cell.formula)}</f>${value}</c>`;
      }
      if (cell.number !== undefined && cell.number !== null) return `<c r="${ref}"${style}><v>${cell.number}</v></c>`;
      if (cell.text !== undefined && cell.text !== '') return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(cell.text)}</t></is></c>`;
      return `<c r="${ref}"${style}/>`;
    }).join('');
    return `<row r="${r + 1}">${body}</row>`;
  }).join('');

  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const mergeXml = merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const border = '<border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border>';
  const centered = '<alignment horizontal="center" vertical="center"/>';
  const moneyFormat = `&quot;${xmlText(currency)}&quot;#,##0.00`;

  const files = {
    '[Content_Types].xml': `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${head}<workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="${xmlText(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets><calcPr fullCalcOnLoad="1"/></workbook>`,
    'xl/_rels/workbook.xml.rels': `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `${head}<styleSheet xmlns="${main}"><numFmts count="1"><numFmt numFmtId="164" formatCode="${moneyFormat}"/></numFmts>`
      + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills>'
      + `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>${border}</borders>`
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="6">'
      + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
      + `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${centered}</xf>`
      + `<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">${centered}</xf>`
      + `<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">${centered}</xf>`
      + `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">${centered}</xf>`
      + `<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">${centered}</xf>`
      + '</cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': `${head}<worksheet xmlns="${main}">${cols}<sheetData>${sheetRows}</sheetData>${mergeXml}</worksheet>`,
  };
  return new Blob([makeZip(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
