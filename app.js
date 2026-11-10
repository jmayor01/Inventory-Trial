'use strict';

const STORAGE_KEY = 'inventory.items.v1';
const $ = (id) => document.getElementById(id);

// ---------- Data ----------

/** @type {{id:string, barcode:string, name:string, description:string, price:number, qty:number, updatedAt:string}[]} */
let items = loadItems();

function loadItems() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveItems() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    toast('Could not save — device storage is full or blocked.');
  }
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

const money = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toNumber = (v) => {
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

// ---------- List ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const shown = items
    .filter((it) => !q || [it.name, it.description, it.barcode].some((f) => (f || '').toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name));

  const list = $('list');
  list.replaceChildren();
  for (const it of shown) {
    const li = el('li', 'item');

    const main = el('button', 'item-main');
    main.type = 'button';
    main.setAttribute('aria-label', `Edit ${it.name}`);
    main.append(el('div', 'item-name', it.name));
    if (it.description) main.append(el('div', 'item-desc', it.description));
    main.append(el('div', 'item-price', money.format(it.price)));
    if (it.barcode) main.append(el('div', 'item-meta', `Barcode ${it.barcode}`));
    main.addEventListener('click', () => openItem(it));

    const qty = el('div', 'qty');
    const minus = el('button', '', '−');
    minus.type = 'button';
    minus.setAttribute('aria-label', `Decrease quantity of ${it.name}`);
    minus.disabled = it.qty <= 0;
    minus.addEventListener('click', () => changeQty(it.id, -1));
    const out = el('output', '', String(it.qty));
    out.setAttribute('aria-label', `Quantity ${it.qty}`);
    const plus = el('button', '', '+');
    plus.type = 'button';
    plus.setAttribute('aria-label', `Increase quantity of ${it.name}`);
    plus.addEventListener('click', () => changeQty(it.id, 1));
    qty.append(minus, out, plus);

    li.append(main, qty);
    list.append(li);
  }

  $('empty').hidden = items.length > 0;
  const total = items.reduce((sum, it) => sum + it.price * it.qty, 0);
  $('summary').textContent = items.length
    ? `${shown.length === items.length ? items.length : `${shown.length} of ${items.length}`} item${items.length === 1 ? '' : 's'} · total value ${money.format(total)}`
    : '';
}

function changeQty(id, delta) {
  const it = items.find((x) => x.id === id);
  if (!it) return;
  it.qty = Math.max(0, it.qty + delta);
  it.updatedAt = new Date().toISOString();
  saveItems();
  render();
}

// ---------- Item form ----------

let editingId = null;

function openItem(item, presetBarcode) {
  editingId = item ? item.id : null;
  $('itemTitle').textContent = item ? 'Edit item' : 'Add item';
  $('fBarcode').value = item ? item.barcode : presetBarcode || '';
  $('fName').value = item ? item.name : '';
  $('fDesc').value = item ? item.description : '';
  $('fPrice').value = item ? item.price : '';
  $('fQty').value = item ? item.qty : '';
  $('fDelete').hidden = !item;
  $('formError').hidden = true;
  $('itemDlg').showModal();
  if (!item) $(presetBarcode ? 'fName' : 'fBarcode').focus();
}

$('itemForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('fName').value.trim();
  const barcode = $('fBarcode').value.trim();
  const fail = (msg, field) => {
    $('formError').textContent = msg;
    $('formError').hidden = false;
    field.focus();
  };
  if (!name) return fail('Please enter a name.', $('fName'));
  const dup = barcode && items.find((x) => x.barcode === barcode && x.id !== editingId);
  if (dup) return fail(`Barcode already used by "${dup.name}".`, $('fBarcode'));

  const data = {
    barcode,
    name,
    description: $('fDesc').value.trim(),
    price: toNumber($('fPrice').value),
    qty: Math.round(toNumber($('fQty').value)),
    updatedAt: new Date().toISOString(),
  };
  const existing = items.find((x) => x.id === editingId);
  if (existing) Object.assign(existing, data);
  else items.push({ id: newId(), ...data });
  saveItems();
  render();
  $('itemDlg').close();
  toast(existing ? 'Item updated' : 'Item added');
});

$('fCancel').addEventListener('click', () => $('itemDlg').close());

$('fDelete').addEventListener('click', () => {
  const it = items.find((x) => x.id === editingId);
  if (!it || !confirm(`Delete "${it.name}"? This cannot be undone.`)) return;
  items = items.filter((x) => x.id !== editingId);
  saveItems();
  render();
  $('itemDlg').close();
  toast('Item deleted');
});

$('fScan').addEventListener('click', () => openScanner((code) => { $('fBarcode').value = code; $('fName').focus(); }));

// ---------- Barcode scanner ----------

// Uses ZXing compiled to WebAssembly (vendor/), so scanning behaves the same on
// Android and iOS and keeps working offline.
BarcodeDetectionAPI.prepareZXingModule({
  overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? 'vendor/zxing_reader.wasm' : prefix + path) },
});
const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar', 'qr_code', 'data_matrix'];

let scanSession = null; // { stream, timer }

function stopScanner() {
  const s = scanSession;
  scanSession = null;
  if (!s) return;
  clearTimeout(s.timer);
  if (s.stream) s.stream.getTracks().forEach((t) => t.stop());
  $('scanVideo').srcObject = null;
}

async function openScanner(onCode) {
  const dlg = $('scanDlg');
  const err = $('scanError');
  const video = $('scanVideo');
  err.hidden = true;
  stopScanner();
  dlg.showModal();

  const session = { stream: null, timer: 0 };
  scanSession = session;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('unsupported');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    // Dialog was cancelled while the permission prompt was open.
    if (scanSession !== session) { stream.getTracks().forEach((t) => t.stop()); return; }
    session.stream = stream;
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    if (scanSession !== session) return;
    stopScanner();
    const name = (e && e.name) || '';
    err.textContent = /NotAllowed|Security/i.test(name)
      ? 'Camera access was blocked. Allow camera access for this site in your browser settings, then try again.'
      : !window.isSecureContext
        ? 'The camera only works over a secure (https) connection.'
        : 'Could not start the camera on this device. You can still type the barcode in manually.';
    err.hidden = false;
    return;
  }

  const detector = new BarcodeDetectionAPI.BarcodeDetector({ formats: BARCODE_FORMATS });
  const tick = async () => {
    if (scanSession !== session) return;
    let code = '';
    try {
      if (video.readyState >= 2) {
        const found = await detector.detect(video);
        if (found.length) code = found[0].rawValue.trim();
      }
    } catch { /* frame not ready; try the next one */ }
    if (scanSession !== session) return;
    if (code) {
      if (navigator.vibrate) navigator.vibrate(60);
      dlg.close(); // the close handler stops the camera
      onCode(code);
    } else {
      session.timer = setTimeout(tick, 120);
    }
  };
  tick();
}

$('scanCancel').addEventListener('click', () => $('scanDlg').close());
$('scanDlg').addEventListener('close', stopScanner);

$('scanBtn').addEventListener('click', () =>
  openScanner((code) => {
    const found = items.find((x) => x.barcode === code);
    if (found) {
      toast(`Found: ${found.name}`);
      openItem(found);
    } else {
      toast('New barcode — add the item details');
      openItem(null, code);
    }
  }),
);

$('addBtn').addEventListener('click', () => openItem(null));
$('search').addEventListener('input', render);

// ---------- Backup: CSV export / import ----------

const CSV_COLUMNS = ['barcode', 'name', 'description', 'price', 'qty'];

function csvCell(v) {
  let s = String(v ?? '');
  // Prefix cells a spreadsheet would run as a formula.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

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

$('exportBtn').addEventListener('click', () => {
  const lines = [CSV_COLUMNS.join(',')];
  for (const it of items) lines.push(CSV_COLUMNS.map((k) => csvCell(it[k])).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `inventory-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  $('menuMsg').textContent = `Exported ${items.length} item${items.length === 1 ? '' : 's'}.`;
});

$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const rows = parseCsv(await file.text());
  const header = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  const col = (name, ...aliases) => [name, ...aliases].map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const idx = {
    barcode: col('barcode', 'code', 'sku'),
    name: col('name', 'item'),
    description: col('description', 'desc'),
    price: col('price'),
    qty: col('qty', 'quantity'),
  };
  if (idx.name < 0) {
    $('menuMsg').textContent = 'Import failed: the file needs a header row with at least a "name" column.';
    return;
  }
  const get = (r, k) => (idx[k] >= 0 ? (r[idx[k]] || '').trim().replace(/^'(?=[=+\-@])/, '') : '');
  let added = 0, updated = 0;
  for (const r of rows) {
    const name = get(r, 'name');
    if (!name) continue;
    const data = {
      barcode: get(r, 'barcode'),
      name,
      description: get(r, 'description'),
      price: toNumber(get(r, 'price')),
      qty: Math.round(toNumber(get(r, 'qty'))),
      updatedAt: new Date().toISOString(),
    };
    // Rows with a barcode we already have update that item; everything else is added.
    const existing = data.barcode && items.find((x) => x.barcode === data.barcode);
    if (existing) { Object.assign(existing, data); updated++; }
    else { items.push({ id: newId(), ...data }); added++; }
  }
  saveItems();
  render();
  $('menuMsg').textContent = `Import done: ${added} added, ${updated} updated.`;
});

$('menuBtn').addEventListener('click', () => { $('menuMsg').textContent = ''; $('menuDlg').showModal(); });
$('menuClose').addEventListener('click', () => $('menuDlg').close());

// ---------- Misc ----------

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}

// Ask the browser not to evict our data when storage is tight.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
