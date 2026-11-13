'use strict';

// Code shared by the inventory app (app.js) and the back office (admin.js).
//
// Each page script defines three globals that the helpers below use:
//   sb      - its Supabase client
//   items   - the current list of items
//   render  - a function that redraws the page
// and includes the matching markup (item form, scanner and confirm dialogs).

const $ = (id) => document.getElementById(id);

const ITEM_COLUMNS = 'id,barcode,name,description,price,qty,photo_updated_at,updated_at';

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
  if (code === '28000') return 'That passcode is not valid.';
  if (code === '42501' || code === 'PGRST301') return 'You do not have permission to do that. Try signing in again.';
  return fallback;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}


function csvCell(v) {
  let s = String(v ?? '');
  // Prefix cells a spreadsheet would run as a formula.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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

function clearPhotoCache() {
  photos.clear();
  photoVersion.clear();
  photoTx(photoDb, 'readwrite', (store) => store.clear()).catch(() => {});
}

// How photos are downloaded. Signed-in staff read the table directly; a page
// can swap this for another route (the inventory app does for passcode viewers).
let photoFetcher = (ids) => sb.from('item_photos').select('item_id,data').in('item_id', ids);

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
        const { data, error } = await photoFetcher(stale.slice(i, i + 10));
        if (error) return; // offline: try again on the next refresh
        for (const row of data || []) cachePhoto(row.item_id, withPhoto.get(row.item_id), row.data);
        if (data && data.length) render();
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

// ---------- Item form: photo, busy state, errors ----------

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

function setFormBusy(busy) {
  for (const b of $('itemForm').querySelectorAll('button')) b.disabled = busy;
  $('fSave').textContent = busy ? 'Saving…' : 'Save';
}

function showFormError(msg, field) {
  $('formError').textContent = msg;
  $('formError').hidden = false;
  if (field) field.focus();
}

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

$('fScan').addEventListener('click', () => openScanner((code) => { $('fBarcode').value = code; $('fName').focus(); }));

/**
 * Makes up a barcode for a product that has none. It is a valid EAN-13 that
 * starts with 2, the range kept free for a shop's own use, so it never clashes
 * with a manufacturer's barcode and can be printed and scanned like any other.
 */
function generateBarcode() {
  for (;;) {
    let digits = '2';
    const random = crypto.getRandomValues(new Uint8Array(11));
    for (const r of random) digits += String(r % 10);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (i % 2 ? 3 : 1);
    const code = digits + String((10 - (sum % 10)) % 10);
    if (!items.some((it) => it.barcode === code)) return code;
  }
}

$('fGenerate').addEventListener('click', () => {
  $('fBarcode').value = generateBarcode();
  toast('Barcode generated');
});

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

