'use strict';

const $ = (id) => document.getElementById(id);

// ---------- Shared inventory (Supabase) ----------
// Items live in a Supabase database so everyone who opens the app sees the same
// list. There is no sign-in: the database rules in supabase/setup.sql allow
// anyone to read and change the inventory. This device only keeps a copy for
// viewing while offline.

const CACHE_KEY = 'inventory.cache.v2';
const LEGACY_KEY = 'inventory.items.v1'; // items from before the inventory was shared
const ITEM_COLUMNS = 'id,barcode,name,description,price,qty,photo_updated_at,updated_at';

const sb = supabase.createClient(window.INVENTORY_CONFIG.supabaseUrl, window.INVENTORY_CONFIG.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

/** @type {{id:string, barcode:string, name:string, description:string, price:number, qty:number, photo_updated_at:string|null}[]} */
let items = [];
let loaded = false; // false until the list has come from the server or the offline copy

const fromRow = (r) => ({ ...r, price: Number(r.price) || 0, qty: Number(r.qty) || 0 });

const money = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toNumber = (v) => {
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** Turns a Supabase error into a message a user can act on. */
function explain(error, fallback) {
  const code = (error && error.code) || '';
  const message = (error && error.message) || '';
  if (!navigator.onLine || /failed to fetch|networkerror|load failed/i.test(message)) return 'No internet connection. Try again when you are back online.';
  if (code === '23505') return 'That barcode is already used by another item.';
  if (code === '42P01' || code === 'PGRST205' || code === 'PGRST202') return 'The database is not set up yet. Run supabase/setup.sql in the Supabase SQL Editor.';
  if (code === '42501' || code === 'PGRST301') return 'The database is not open to the app yet. Run the latest supabase/setup.sql in the Supabase SQL Editor.';
  return fallback;
}

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    return c && Array.isArray(c.items) ? c.items : null;
  } catch {
    return null;
  }
}

function writeCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ items })); } catch { /* storage full: offline copy is optional */ }
}

function setStatus(text) {
  $('status').textContent = text;
  $('status').hidden = !text;
}

/** Loads every item from the server. Throws on failure. */
async function refresh() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('items').select(ITEM_COLUMNS).order('id').range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  items = rows.map(fromRow);
  loaded = true;
  writeCache();
  render();
  syncPhotos();
}

async function refreshQuietly() {
  try {
    await refresh();
    setStatus('');
  } catch (e) {
    setStatus(`${explain(e, 'Could not load the latest items.')}${items.length ? ' Showing the copy saved on this device.' : ''}`);
    loaded = true;
    render();
  }
}

let refreshTimer = 0;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshQuietly, 400);
}

// Live updates: reload when anyone changes the items table.
let channel = null;
function startRealtime() {
  channel = sb.channel('items-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, scheduleRefresh)
    .subscribe();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRefresh(); });
window.addEventListener('online', scheduleRefresh);

// ---------- Photos ----------
// Photos are shrunk on the phone and stored in the item_photos table. They are
// downloaded once and kept in IndexedDB; items.photo_updated_at tells us when a
// copy is out of date. `photos` mirrors that cache so the list renders at once.

const PHOTO_MAX_SIDE = 640;
const photos = new Map(); // item id -> data URL
const photoVersion = new Map(); // item id -> photo_updated_at of the cached copy
let photoDb = null;

function openDb(name, createStore) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { if (createStore) req.result.createObjectStore('photos'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function photoTx(db, mode, run) {
  return new Promise((resolve, reject) => {
    if (!db || !db.objectStoreNames.contains('photos')) return reject(new Error('Photo storage is not available'));
    const tx = db.transaction('photos', mode);
    const result = run(tx.objectStore('photos'));
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

function readAllPhotos(db) {
  const out = [];
  return photoTx(db, 'readonly', (store) => {
    store.openCursor().onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { out.push([cur.key, cur.value]); cur.continue(); }
    };
  }).then(() => out);
}

async function loadPhotoCache() {
  try {
    photoDb = await openDb('inventory-shared', true);
    for (const [id, entry] of await readAllPhotos(photoDb)) {
      photos.set(id, entry.data);
      photoVersion.set(id, entry.v);
    }
  } catch { /* e.g. private browsing: photos still work, just without the cache */ }
}

function cachePhoto(id, version, data) {
  photos.set(id, data);
  photoVersion.set(id, version);
  photoTx(photoDb, 'readwrite', (store) => store.put({ v: version, data }, id)).catch(() => {});
}

function uncachePhoto(id) {
  photos.delete(id);
  photoVersion.delete(id);
  photoTx(photoDb, 'readwrite', (store) => store.delete(id)).catch(() => {});
}

let photoSync = { running: false, again: false };
async function syncPhotos() {
  if (photoSync.running) { photoSync.again = true; return; }
  photoSync.running = true;
  try {
    do {
      photoSync.again = false;
      const withPhoto = new Map(items.filter((it) => it.photo_updated_at).map((it) => [it.id, it.photo_updated_at]));
      let changed = false;
      for (const id of [...photos.keys()]) {
        if (!withPhoto.has(id)) { uncachePhoto(id); changed = true; }
      }
      if (changed) render();
      const stale = [...withPhoto.keys()].filter((id) => photoVersion.get(id) !== withPhoto.get(id));
      for (let i = 0; i < stale.length; i += 10) {
        const { data, error } = await sb.from('item_photos').select('item_id,data').in('item_id', stale.slice(i, i + 10));
        if (error) return; // offline: try again on the next refresh
        for (const row of data) cachePhoto(row.item_id, withPhoto.get(row.item_id), row.data);
        if (data.length) render();
      }
    } while (photoSync.again);
  } finally {
    photoSync.running = false;
  }
}

/** Shrinks a picked image file to a JPEG data URL no larger than PHOTO_MAX_SIDE. */
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // transparent PNGs would otherwise turn black as JPEG
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not an image')); };
    img.src = url;
  });
}

// ---------- List ----------

const LOW_STOCK = 5; // "Low stock" means this many units or fewer (but not zero)
const isOut = (it) => it.qty <= 0;
const isLow = (it) => it.qty > 0 && it.qty <= LOW_STOCK;

// Barcode most recently put into the search box by the camera.
let scannedQuery = '';
let stockFilter = 'all'; // 'all' | 'low' | 'out'
let detailId = null; // item shown in the details dialog

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function stockBadge(it) {
  if (isOut(it)) return el('span', 'badge out', 'Out of stock');
  if (isLow(it)) return el('span', 'badge low', 'Low stock');
  return null;
}

/** The item's photo, or a tile with its first letter when it has none. */
function thumbFor(it) {
  if (photos.has(it.id)) {
    const img = el('img', 'thumb');
    img.src = photos.get(it.id);
    img.alt = '';
    img.loading = 'lazy';
    return img;
  }
  const tile = el('div', 'thumb placeholder', (it.name.trim()[0] || '?'));
  tile.setAttribute('aria-hidden', 'true');
  return tile;
}

function qtyControls(it) {
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
  return qty;
}

/**
 * Full details of one item: large photo and every field. Used inline when a
 * search matches a single item, and in the dialog opened by tapping a row.
 */
function detailCard(it, inDialog) {
  const card = el(inDialog ? 'div' : 'li', 'detail');
  card.setAttribute('aria-label', `Details of ${it.name}`);

  if (photos.has(it.id)) {
    const img = el('img', 'detail-photo');
    img.src = photos.get(it.id);
    img.alt = `Photo of ${it.name}`;
    card.append(img);
  } else if (it.photo_updated_at) {
    card.append(el('p', 'detail-nophoto', 'Loading photo…'));
  }

  const head = el('div', 'detail-head');
  head.append(el('h2', 'detail-name', it.name));
  const badge = stockBadge(it);
  if (badge) head.append(badge);
  card.append(head);
  card.append(el('p', it.description ? 'detail-desc' : 'detail-desc muted', it.description || 'No description'));

  const facts = el('dl', 'detail-facts');
  const fact = (label, value) => {
    const dd = el('dd');
    dd.append(value);
    facts.append(el('dt', '', label), dd);
  };
  fact('Price', money.format(it.price));
  fact('In stock', qtyControls(it));
  fact('Stock value', money.format(it.price * it.qty));
  fact('Barcode', it.barcode || 'None');
  const updated = it.updated_at ? new Date(it.updated_at) : null;
  if (updated && !Number.isNaN(updated.getTime())) {
    fact('Last updated', updated.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
  }
  card.append(facts);

  const actions = el('div', 'detail-actions');
  const back = el('button', 'btn', inDialog ? 'Close' : 'Show all items');
  back.type = 'button';
  back.addEventListener('click', () => {
    if (inDialog) { $('detailDlg').close(); return; }
    $('search').value = '';
    render();
  });
  const edit = el('button', 'btn primary', 'Edit');
  edit.type = 'button';
  edit.setAttribute('aria-label', `Edit ${it.name}`);
  edit.addEventListener('click', () => {
    if (inDialog) $('detailDlg').close();
    openItem(it);
  });
  actions.append(back, edit);
  card.append(actions);
  return card;
}

function openDetails(it) {
  detailId = it.id;
  $('detailBody').replaceChildren(detailCard(it, true));
  if (!$('detailDlg').open) $('detailDlg').showModal();
}

function itemRow(it) {
  const li = el('li', 'item');

  const main = el('button', 'item-main');
  main.type = 'button';
  main.setAttribute('aria-label', `View details of ${it.name}`);
  main.append(thumbFor(it));
  const text = el('div', 'item-text');
  text.append(el('div', 'item-name', it.name));
  const sub = el('div', 'item-sub');
  sub.append(el('span', 'item-price', money.format(it.price)));
  const badge = stockBadge(it);
  if (badge) sub.append(badge);
  text.append(sub);
  const meta = it.description || (it.barcode ? `Barcode ${it.barcode}` : '');
  if (meta) text.append(el('div', 'item-meta', meta));
  main.append(text);
  main.addEventListener('click', () => openDetails(it));

  li.append(main, qtyControls(it));
  return li;
}

function render() {
  const raw = $('search').value.trim();
  const q = raw.toLowerCase();
  const shown = items
    .filter((it) => !q || [it.name, it.description, it.barcode].some((f) => (f || '').toLowerCase().includes(q)))
    .filter((it) => (stockFilter === 'low' ? isLow(it) : stockFilter === 'out' ? isOut(it) : true))
    .sort((a, b) => a.name.localeCompare(b.name));

  const list = $('list');
  list.replaceChildren();
  if (!loaded) {
    for (let i = 0; i < 4; i++) list.append(el('li', 'skeleton'));
  } else if (q && shown.length === 1) {
    // A search that narrows down to one item shows everything about it.
    list.append(detailCard(shown[0], false));
  } else {
    for (const it of shown) list.append(itemRow(it));
  }
  list.setAttribute('aria-busy', String(!loaded));

  // Totals and filter chips always describe the whole inventory.
  const ready = loaded;
  $('statItems').textContent = ready ? String(items.length) : '–';
  $('statUnits').textContent = ready ? String(items.reduce((sum, it) => sum + it.qty, 0)) : '–';
  $('statValue').textContent = ready ? money.format(items.reduce((sum, it) => sum + it.price * it.qty, 0)) : '–';
  $('countAll').textContent = ready ? String(items.length) : '';
  $('countLow').textContent = ready ? String(items.filter(isLow).length) : '';
  $('countOut').textContent = ready ? String(items.filter(isOut).length) : '';
  for (const chip of document.querySelectorAll('.chip')) chip.setAttribute('aria-pressed', String(chip.dataset.filter === stockFilter));

  const filtering = Boolean(q) || stockFilter !== 'all';
  $('summary').textContent = loaded && filtering && items.length
    ? `Showing ${shown.length} of ${items.length} item${items.length === 1 ? '' : 's'}`
    : '';

  $('empty').hidden = !loaded || items.length > 0;
  const noResults = loaded && items.length > 0 && shown.length === 0;
  $('noResults').hidden = !noResults;
  if (noResults) {
    $('noResultsText').textContent = !q
      ? (stockFilter === 'low' ? 'No items are low on stock.' : 'No items are out of stock.')
      : raw === scannedQuery ? `No item has barcode ${raw}.` : `No item matches "${raw}".`;
    $('noResultsAdd').hidden = !q;
  }

  // Keep an open details dialog in step with the data.
  if ($('detailDlg').open) {
    const it = items.find((x) => x.id === detailId);
    if (it) $('detailBody').replaceChildren(detailCard(it, true)); else $('detailDlg').close();
  }
}

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => { stockFilter = chip.dataset.filter; render(); });
}

/** Asks a yes/no question in the app's own dialog; resolves to true for yes. */
function confirmDialog({ title, text, ok, danger }) {
  return new Promise((resolve) => {
    const dlg = $('confirmDlg');
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmOk').textContent = ok;
    $('confirmOk').className = danger ? 'btn danger solid' : 'btn primary';
    let answer = false;
    const onOk = () => { answer = true; dlg.close(); };
    const onCancel = () => dlg.close();
    const onClose = () => {
      $('confirmOk').removeEventListener('click', onOk);
      $('confirmCancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('close', onClose);
      resolve(answer);
    };
    $('confirmOk').addEventListener('click', onOk);
    $('confirmCancel').addEventListener('click', onCancel);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

const qtyPending = new Map(); // item id -> number of +/- taps still being saved

async function changeQty(id, delta) {
  const it = items.find((x) => x.id === id);
  if (!it) return;
  it.qty = Math.max(0, it.qty + delta);
  render();
  qtyPending.set(id, (qtyPending.get(id) || 0) + 1);
  const { data, error } = await sb.rpc('adjust_qty', { p_id: id, p_delta: delta });
  const left = qtyPending.get(id) - 1;
  if (left) qtyPending.set(id, left); else qtyPending.delete(id);
  if (error) {
    toast(explain(error, 'Could not update the quantity.'));
    if (!left) refreshQuietly();
    return;
  }
  // The server's number wins (someone else may have changed it too), but only
  // once our own taps have all been saved.
  const cur = items.find((x) => x.id === id);
  if (cur && !left && typeof data === 'number') {
    cur.qty = data;
    writeCache();
    render();
  }
}

// ---------- Item form ----------

let editingId = null;
let formPhoto = null; // data URL shown in the form, or null
let formPhotoOriginal = null; // what the form opened with, to detect changes

function showFormPhoto(dataUrl) {
  formPhoto = dataUrl || null;
  const preview = $('fPhotoPreview');
  preview.hidden = !formPhoto;
  if (formPhoto) preview.src = formPhoto; else preview.removeAttribute('src');
  $('fPhotoRemove').hidden = !formPhoto;
}

// "Take photo" opens the phone's camera directly; "Gallery" picks an existing picture.
$('fPhotoCamera').addEventListener('click', () => $('fPhotoCameraFile').click());
$('fPhotoPick').addEventListener('click', () => $('fPhotoFile').click());
$('fPhotoRemove').addEventListener('click', () => showFormPhoto(null));
async function onPhotoPicked(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    showFormPhoto(await shrinkImage(file));
  } catch {
    toast('That file could not be read as an image.');
  }
}
$('fPhotoCameraFile').addEventListener('change', onPhotoPicked);
$('fPhotoFile').addEventListener('change', onPhotoPicked);

function openItem(item, presetBarcode) {
  editingId = item ? item.id : null;
  $('itemTitle').textContent = item ? 'Edit item' : 'Add item';
  $('fBarcode').value = item ? item.barcode : presetBarcode || '';
  $('fName').value = item ? item.name : '';
  $('fDesc').value = item ? item.description : '';
  $('fPrice').value = item ? item.price : '';
  $('fQty').value = item ? item.qty : '';
  showFormPhoto(item ? photos.get(item.id) : null);
  formPhotoOriginal = formPhoto;
  $('fDelete').hidden = !item;
  $('formError').hidden = true;
  $('itemDlg').showModal();
  // Adding starts typing straight away; editing does not pop the keyboard up.
  $(item ? 'itemTitle' : 'fName').focus();
}

function setFormBusy(busy) {
  for (const b of $('itemForm').querySelectorAll('button')) b.disabled = busy;
  $('fSave').textContent = busy ? 'Saving…' : 'Save';
}

function showFormError(msg, field) {
  $('formError').textContent = msg;
  $('formError').hidden = false;
  if (field) field.focus();
}

$('itemForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('fName').value.trim();
  const barcode = $('fBarcode').value.trim();
  if (!name) return showFormError('Please enter a name.', $('fName'));
  const dup = barcode && items.find((x) => x.barcode === barcode && x.id !== editingId);
  if (dup) return showFormError(`Barcode already used by "${dup.name}".`, $('fBarcode'));

  const row = {
    barcode,
    name,
    description: $('fDesc').value.trim(),
    price: toNumber($('fPrice').value),
    qty: Math.round(toNumber($('fQty').value)),
  };
  const isEdit = Boolean(editingId);
  $('formError').hidden = true;
  setFormBusy(true);
  try {
    const query = isEdit ? sb.from('items').update(row).eq('id', editingId) : sb.from('items').insert(row);
    const { data, error } = await query.select(ITEM_COLUMNS).single();
    if (error) return showFormError(explain(error, isEdit ? 'Could not save. The item may have been deleted by someone else.' : 'Could not save the item.'));
    let saved = fromRow(data);

    let photoOk = true;
    if (formPhoto !== formPhotoOriginal) {
      try {
        saved = await savePhoto(saved, formPhoto);
      } catch {
        photoOk = false;
      }
    }

    const i = items.findIndex((x) => x.id === saved.id);
    if (i >= 0) items[i] = saved; else items.push(saved);
    writeCache();
    render();
    $('itemDlg').close();
    toast(!photoOk ? 'Item saved, but the photo could not be uploaded.' : isEdit ? 'Item updated' : 'Item added');
  } finally {
    setFormBusy(false);
  }
});

/** Stores or removes an item's photo on the server; returns the updated item. */
async function savePhoto(item, dataUrl) {
  if (dataUrl) {
    const up = await sb.from('item_photos').upsert({ item_id: item.id, data: dataUrl });
    if (up.error) throw up.error;
  }
  const { data, error } = await sb.from('items')
    .update({ photo_updated_at: dataUrl ? new Date().toISOString() : null })
    .eq('id', item.id).select(ITEM_COLUMNS).single();
  if (error) throw error;
  const saved = fromRow(data);
  if (dataUrl) {
    cachePhoto(saved.id, saved.photo_updated_at, dataUrl);
  } else {
    uncachePhoto(saved.id);
    await sb.from('item_photos').delete().eq('item_id', saved.id);
  }
  return saved;
}

$('fCancel').addEventListener('click', () => $('itemDlg').close());

$('fDelete').addEventListener('click', async () => {
  const it = items.find((x) => x.id === editingId);
  if (!it) return;
  const yes = await confirmDialog({
    title: `Delete "${it.name}"?`,
    text: 'It will be removed for everyone who uses this inventory. This cannot be undone.',
    ok: 'Delete',
    danger: true,
  });
  if (!yes) return;
  setFormBusy(true);
  try {
    const { error } = await sb.from('items').delete().eq('id', it.id);
    if (error) return showFormError(explain(error, 'Could not delete the item.'));
    items = items.filter((x) => x.id !== it.id);
    uncachePhoto(it.id);
    writeCache();
    render();
    $('itemDlg').close();
    toast('Item deleted');
  } finally {
    setFormBusy(false);
  }
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
let scanCallback = null; // what to do with the barcode once we have one

function stopScanner() {
  const s = scanSession;
  scanSession = null;
  if (!s) return;
  clearTimeout(s.timer);
  if (s.stream) s.stream.getTracks().forEach((t) => t.stop());
  $('scanVideo').srcObject = null;
  $('torchBtn').hidden = true;
}

async function openScanner(onCode) {
  const dlg = $('scanDlg');
  const err = $('scanError');
  const video = $('scanVideo');
  err.hidden = true;
  stopScanner();
  scanCallback = onCode;
  $('scanManualInput').value = '';
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
    setUpTorch(stream);
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
    $('scanManualInput').focus();
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
      finishScan(code);
    } else {
      session.timer = setTimeout(tick, 120);
    }
  };
  tick();
}

function finishScan(code) {
  const cb = scanCallback;
  $('scanDlg').close(); // the close handler stops the camera
  if (cb) cb(code);
}

/** Shows the Light button on phones whose camera lets the page switch the flash on. */
function setUpTorch(stream) {
  const btn = $('torchBtn');
  btn.hidden = true;
  btn.setAttribute('aria-pressed', 'false');
  try {
    const track = stream.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    if (!caps.torch) return;
    btn.hidden = false;
    btn.onclick = async () => {
      const on = btn.getAttribute('aria-pressed') !== 'true';
      try {
        await track.applyConstraints({ advanced: [{ torch: on }] });
        btn.setAttribute('aria-pressed', String(on));
      } catch {
        btn.hidden = true;
      }
    };
  } catch { /* no flash control on this device */ }
}

// Typing the barcode works when the camera cannot read it (or is not allowed).
$('scanManual').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('scanManualInput').value.trim();
  if (code) finishScan(code);
});

$('scanCancel').addEventListener('click', () => $('scanDlg').close());
$('scanDlg').addEventListener('close', () => { stopScanner(); scanCallback = null; });

$('scanBtn').addEventListener('click', () =>
  openScanner((code) => {
    const found = items.find((x) => x.barcode === code);
    if (found) {
      openDetails(found);
    } else {
      toast('New barcode — add the item details');
      openItem(null, code);
    }
  }),
);

$('addBtn').addEventListener('click', () => openItem(null));
$('search').addEventListener('input', render);

// Search by barcode: scan, then show only the matching item(s) in the list.
$('searchScan').addEventListener('click', () =>
  openScanner((code) => {
    scannedQuery = code;
    $('search').value = code;
    render();
  }),
);

$('noResultsAdd').addEventListener('click', () => {
  const raw = $('search').value.trim();
  openItem(null, raw === scannedQuery ? raw : '');
});

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

  $('menuMsg').textContent = 'Importing…';
  try {
    await refresh(); // match barcodes against what is on the server right now
  } catch (err) {
    $('menuMsg').textContent = `Import failed: ${explain(err, 'could not reach the database.')}`;
    return;
  }
  // Rows whose barcode already exists update that item; everything else is added.
  const idByBarcode = new Map(items.filter((it) => it.barcode).map((it) => [it.barcode, it.id]));
  const existingIds = new Set(items.map((it) => it.id));
  const out = new Map(); // id -> row; a barcode repeated in the file keeps its last row
  for (const r of rows) {
    const name = get(r, 'name');
    if (!name) continue;
    const barcode = get(r, 'barcode');
    let id = barcode && idByBarcode.get(barcode);
    if (!id) {
      id = crypto.randomUUID();
      if (barcode) idByBarcode.set(barcode, id);
    }
    out.set(id, { id, barcode, name, description: get(r, 'description'), price: toNumber(get(r, 'price')), qty: Math.round(toNumber(get(r, 'qty'))) });
  }
  const all = [...out.values()];
  for (let i = 0; i < all.length; i += 500) {
    const { error } = await sb.from('items').upsert(all.slice(i, i + 500));
    if (error) {
      $('menuMsg').textContent = `Import stopped after ${i} rows: ${explain(error, 'the database rejected the data.')}`;
      refreshQuietly();
      return;
    }
  }
  const updated = all.filter((r) => existingIds.has(r.id)).length;
  await refreshQuietly();
  $('menuMsg').textContent = `Import done: ${all.length - updated} added, ${updated} updated.`;
});

$('menuBtn').addEventListener('click', () => {
  $('menuMsg').textContent = '';
  const old = legacyItems().length;
  $('legacyBtn').hidden = !old;
  $('legacyBtn').textContent = `Upload ${old} item${old === 1 ? '' : 's'} saved on this device`;
  $('menuDlg').showModal();
});
$('menuClose').addEventListener('click', () => $('menuDlg').close());

// ---------- Items saved on this device before the inventory was shared ----------

function legacyItems() {
  try {
    const data = JSON.parse(localStorage.getItem(LEGACY_KEY));
    return Array.isArray(data) ? data.filter((o) => o && o.name) : [];
  } catch {
    return [];
  }
}

/** Uploads the old on-device items (and photos); returns how many were added. */
async function uploadLegacy() {
  await refresh();
  const taken = new Set(items.map((it) => it.barcode).filter(Boolean));
  const newIdFor = new Map();
  const rows = [];
  for (const o of legacyItems()) {
    const barcode = String(o.barcode || '').trim();
    if (barcode && taken.has(barcode)) continue; // already in the shared inventory
    if (barcode) taken.add(barcode);
    const id = crypto.randomUUID();
    newIdFor.set(o.id, id);
    rows.push({ id, barcode, name: String(o.name), description: String(o.description || ''), price: toNumber(o.price), qty: Math.round(toNumber(o.qty)) });
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from('items').insert(rows.slice(i, i + 500));
    if (error) throw error;
  }
  try {
    const oldDb = await openDb('inventory', false);
    for (const [oldId, dataUrl] of await readAllPhotos(oldDb)) {
      const id = newIdFor.get(oldId);
      if (id && typeof dataUrl === 'string') await savePhoto({ id }, dataUrl).catch(() => {});
    }
    oldDb.close();
  } catch { /* no old photos on this device */ }
  // Keep the old list under another name instead of deleting it outright.
  localStorage.setItem(`${LEGACY_KEY}.uploaded`, localStorage.getItem(LEGACY_KEY));
  localStorage.removeItem(LEGACY_KEY);
  await refreshQuietly();
  return rows.length;
}

async function runLegacyUpload() {
  try {
    const n = await uploadLegacy();
    toast(`Uploaded ${n} item${n === 1 ? '' : 's'} to the shared inventory`);
    return true;
  } catch (e) {
    toast(explain(e, 'Could not upload the items. You can try again under Backup.'));
    return false;
  }
}

async function offerLegacyUpload() {
  const n = legacyItems().length;
  const askedKey = `${LEGACY_KEY}.asked`;
  if (!n || localStorage.getItem(askedKey)) return;
  localStorage.setItem(askedKey, '1');
  const yes = await confirmDialog({
    title: 'Upload items saved on this device?',
    text: `This device has ${n} item${n === 1 ? '' : 's'} saved from before the inventory was shared. You can also upload ${n === 1 ? 'it' : 'them'} later under Backup.`,
    ok: 'Upload',
  });
  if (yes) runLegacyUpload();
}

$('legacyBtn').addEventListener('click', async () => {
  $('legacyBtn').disabled = true;
  if (await runLegacyUpload()) $('legacyBtn').hidden = true;
  $('legacyBtn').disabled = false;
});

// ---------- Install prompt ----------
// Chrome, Edge, Samsung Internet and other Chromium browsers let the page show
// the real install prompt. Safari and Firefox do not, so there we explain the
// few taps it takes instead.

const INSTALL_DISMISSED_KEY = 'inventory.installDismissed';
const INSTALL_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
let installEvent = null; // the browser's own install prompt, when it offers one

function installSteps() {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (iOS) {
    return [
      'Tap the Share button (the square with an arrow pointing up).',
      'Scroll down and tap "Add to Home Screen".',
      'Tap "Add". The Inventory icon appears on your home screen.',
    ];
  }
  if (/Android/.test(ua) && /Firefox/.test(ua)) {
    return [
      'Tap the menu button (three dots).',
      'Tap "Add app to Home screen" (or "Install").',
      'Tap "Add". The Inventory icon appears on your home screen.',
    ];
  }
  return null; // no known manual route on this browser
}

function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function maybeShowInstallBar() {
  let snoozed = false;
  try { snoozed = Date.now() - Number(localStorage.getItem(INSTALL_DISMISSED_KEY) || 0) < INSTALL_SNOOZE_MS; } catch { /* ignore */ }
  $('installBar').hidden = isInstalled() || snoozed || !(installEvent || installSteps());
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // keep it for our own Install button
  installEvent = e;
  maybeShowInstallBar();
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  $('installBar').hidden = true;
  toast('Inventory is installed');
});

$('installBtn').addEventListener('click', async () => {
  if (installEvent) {
    const prompt = installEvent;
    installEvent = null; // a prompt can only be used once
    prompt.prompt();
    const choice = await prompt.userChoice.catch(() => null);
    if (!choice || choice.outcome !== 'accepted') maybeShowInstallBar();
    else $('installBar').hidden = true;
    return;
  }
  const steps = installSteps();
  if (!steps) return;
  $('installSteps').replaceChildren(...steps.map((s) => el('li', '', s)));
  $('installDlg').showModal();
});
$('installClose').addEventListener('click', () => $('installDlg').close());
$('installLater').addEventListener('click', () => {
  try { localStorage.setItem(INSTALL_DISMISSED_KEY, String(Date.now())); } catch { /* ignore */ }
  $('installBar').hidden = true;
});

maybeShowInstallBar();

// ---------- Misc ----------

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}

// Ask the browser not to evict our offline copy when storage is tight.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Start: show the copy saved on this device at once, then load the live list.
const cached = readCache();
items = cached || [];
loaded = Boolean(cached);
render();
loadPhotoCache().then(() => { if (photos.size) render(); });
startRealtime();
refreshQuietly().then(offerLegacyUpload);
