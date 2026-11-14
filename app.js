'use strict';

// The inventory app. Shared helpers (photos, scanner, form bits) are in common.js.

// ---------- Who is using the app ----------
// What a visitor can do depends on `mode`, and the database enforces the same
// rules (supabase/setup.sql), so nothing here is the real lock:
//   public - not signed in, no passcode: look up one item by its barcode
//   viewer - holds a passcode: sees the whole list, read-only. With a cashier
//            passcode (`cashier` is true) they can also sell from a cart.
//   staff  - signed in as admin or super admin: can change everything

const CACHE_KEY = 'inventory.cache.v3';
const PASSCODE_KEY = 'inventory.passcode';
const PASSCODE_KIND_KEY = 'inventory.passcodeKind'; // 'view' | 'cashier'
const CART_KEY = 'inventory.cart';
const ROLE_KEY = 'inventory.role'; // last known role, so staff can open the app offline
const LEGACY_KEY = 'inventory.items.v1'; // items from before the inventory was shared

// The sign-in session is shared with the back office (same site, same storage).
const sb = supabase.createClient(window.INVENTORY_CONFIG.supabaseUrl, window.INVENTORY_CONFIG.supabaseKey);

/** @type {{id:string, barcode:string, name:string, description:string, price:number, qty:number, photo_updated_at:string|null}[]} */
let items = [];
let loaded = false; // false until the list has come from the server or the offline copy
let mode = 'boot'; // 'boot' | 'public' | 'viewer' | 'staff'
let role = null; // 'admin' | 'super_admin' when mode is 'staff'
let passcode = ''; // the passcode in use when mode is 'viewer'
let cashier = false; // true when that passcode is a cashier's
let cart = new Map(); // item id -> quantity, for the sale being rung up
let cartPrices = new Map(); // item id -> custom price for this sale, where the cashier set one
// The public barcode lookup: state is 'idle' | 'loading' | 'found' | 'missing' | 'error'.
let lookup = { state: 'idle', code: '', item: null, message: '' };

const isStaff = () => mode === 'staff';

const stored = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage blocked or full */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

function readCache() {
  try {
    const c = JSON.parse(stored.get(CACHE_KEY));
    return c && c.mode === mode && Array.isArray(c.items) ? c.items : null;
  } catch {
    return null;
  }
}

function writeCache() {
  if (mode === 'staff' || mode === 'viewer') stored.set(CACHE_KEY, JSON.stringify({ mode, items }));
}

/** Removes everything this device remembers about the inventory. */
function forgetPasscode() {
  stored.remove(PASSCODE_KEY);
  stored.remove(PASSCODE_KIND_KEY);
  forgetInventory();
}

function forgetInventory() {
  stored.remove(CACHE_KEY);
  clearPhotoCache();
}

function setStatus(text) {
  $('status').textContent = text;
  $('status').hidden = !text;
}

/** Loads every item the visitor may see. Throws on failure. */
async function refresh() {
  const forMode = mode;
  let rows = [];
  if (mode === 'staff') {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('items').select(ITEM_COLUMNS).order('id').range(from, from + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) break;
    }
  } else if (mode === 'viewer') {
    const { data, error } = await sb.rpc('list_items_with_code', { p_code: passcode });
    if (error) throw error;
    rows = data || [];
  } else {
    return;
  }
  if (forMode !== mode) return; // signed in or out meanwhile
  items = rows.map(fromRow);
  loaded = true;
  writeCache();
  render();
  syncPhotos();
}

async function refreshQuietly() {
  if (mode !== 'staff' && mode !== 'viewer') return;
  const forMode = mode;
  try {
    await refresh();
    setStatus('');
  } catch (e) {
    if (forMode !== mode) return;
    if (mode === 'viewer' && e && e.code === '28000') {
      // The super admin removed this passcode.
      forgetPasscode();
      enterPublic();
      toast('That passcode no longer works.');
      return;
    }
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

// Live updates for signed-in staff: reload when anyone changes the items table.
let channel = null;
function setRealtime(on) {
  if (channel) { sb.removeChannel(channel); channel = null; }
  if (on) {
    channel = sb.channel('items-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, scheduleRefresh)
      .subscribe();
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRefresh(); });
window.addEventListener('online', scheduleRefresh);

function setMode(next, sell) {
  mode = next;
  cashier = next === 'viewer' && Boolean(sell);
  document.body.dataset.mode = next;
  document.body.toggleAttribute('data-sell', cashier);
  $('scanBtnText').textContent = cashier ? 'Scan' : 'Scan barcode';
  $('viewerNote').textContent = cashier ? 'You are signed in with a cashier passcode.' : 'You are viewing the list with a passcode.';
  if (cashier) loadCart(); else clearCart();
  setStatus('');
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  // Passcode viewers get photos through the passcode, staff straight from the table.
  photoFetcher = next === 'viewer'
    ? (ids) => sb.rpc('item_photos_with_code', { p_code: passcode, p_ids: ids })
    : (ids) => sb.from('item_photos').select('item_id,data').in('item_id', ids);
  lookup = { state: 'idle', code: '', item: null, message: '' };
  $('search').value = '';
  $('search').placeholder = next === 'public' ? 'Type or scan a barcode' : 'Search name or barcode';
  const cached = next === 'staff' || next === 'viewer' ? readCache() : null;
  items = cached || [];
  loaded = next === 'public' || Boolean(cached);
  setRealtime(next === 'staff');
  render();
}

function enterPublic() {
  role = null;
  passcode = '';
  setMode('public');
}

function enterViewer(code, kind) {
  role = null;
  passcode = code;
  setMode('viewer', kind === 'cashier');
  refreshQuietly();
}

function enterStaff(newRole, email) {
  role = newRole;
  passcode = '';
  $('accountEmail').textContent = email || '';
  $('accountRole').textContent = newRole === 'super_admin' ? 'super admin' : 'admin';
  setMode('staff');
  refreshQuietly().then(offerLegacyUpload);
}

// ---------- Public barcode lookup ----------

async function lookupBarcode(value) {
  const code = String(value || '').trim();
  if (!code) { $('search').focus(); return; }
  $('search').value = code;
  lookup = { state: 'loading', code, item: null, message: '' };
  render();
  const { data, error } = await sb.rpc('lookup_item', { p_barcode: code });
  if (mode !== 'public' || lookup.code !== code) return; // superseded
  if (error) {
    lookup = { state: 'error', code, item: null, message: explain(error, 'Could not look up that barcode. Please try again.') };
  } else if (!data) {
    lookup = { state: 'missing', code, item: null, message: '' };
  } else {
    const { photo, ...row } = data;
    const item = fromRow(row);
    if (photo) photos.set(item.id, photo); else photos.delete(item.id);
    lookup = { state: 'found', code, item, message: '' };
  }
  render();
}

function renderPublic() {
  const list = $('list');
  list.replaceChildren();
  if (lookup.state === 'loading') list.append(el('li', 'skeleton'));
  if (lookup.state === 'found') list.append(detailCard(lookup.item, false));
  list.setAttribute('aria-busy', String(lookup.state === 'loading'));
  setStatus(lookup.state === 'error' ? lookup.message : '');
  $('summary').textContent = '';
  $('empty').hidden = true;
  $('publicHint').hidden = lookup.state !== 'idle' && lookup.state !== 'error';
  $('noResults').hidden = lookup.state !== 'missing';
  $('noResultsText').textContent = lookup.state === 'missing' ? `No item has barcode ${lookup.code}.` : '';
  $('noResultsAdd').hidden = true;
}

// ---------- List ----------

const LOW_STOCK = 5; // "Low stock" means this many units or fewer (but not zero)
const isOut = (it) => it.qty <= 0;
const isLow = (it) => it.qty > 0 && it.qty <= LOW_STOCK;

// Barcode most recently put into the search box by the camera.
let scannedQuery = '';
let stockFilter = 'all'; // 'all' | 'low' | 'out'
let detailId = null; // item shown in the details dialog

function stockBadge(it) {
  if (isOut(it)) return el('span', 'badge out', 'Out of stock');
  if (isLow(it)) return el('span', 'badge low', 'Low stock');
  return null;
}

/** Stock as plain text, for visitors who cannot change it. */
function qtyText(it) {
  const wrap = el('div', 'qty-text');
  wrap.append(el('strong', '', String(it.qty)), el('span', '', 'in stock'));
  return wrap;
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
  fact('In stock', isStaff() ? qtyControls(it) : String(it.qty));
  if (isStaff()) fact('Stock value', money.format(it.price * it.qty));
  fact('Barcode', it.barcode || 'None');
  const updated = it.updated_at ? new Date(it.updated_at) : null;
  if (updated && !Number.isNaN(updated.getTime())) {
    fact('Last updated', updated.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
  }
  card.append(facts);

  const actions = el('div', 'detail-actions');
  const back = el('button', 'btn', inDialog ? 'Close' : mode === 'public' ? 'Clear' : 'Show all items');
  back.type = 'button';
  back.addEventListener('click', () => {
    if (inDialog) { $('detailDlg').close(); return; }
    $('search').value = '';
    lookup = { state: 'idle', code: '', item: null, message: '' };
    render();
  });
  const edit = el('button', 'btn primary', 'Edit');
  edit.type = 'button';
  edit.setAttribute('aria-label', `Edit ${it.name}`);
  edit.addEventListener('click', () => {
    if (inDialog) $('detailDlg').close();
    openItem(it);
  });
  actions.append(back);
  if (isStaff()) actions.append(edit);
  if (cashier) {
    const add = el('button', 'btn primary', 'Add to cart');
    add.type = 'button';
    add.disabled = (cart.get(it.id) || 0) >= it.qty;
    add.addEventListener('click', () => { addToCart(it); if (inDialog) $('detailDlg').close(); });
    actions.append(add);
  }
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

  li.append(main, isStaff() ? qtyControls(it) : qtyText(it));
  if (cashier) {
    const add = el('button', 'add-cart', 'Add');
    add.type = 'button';
    add.setAttribute('aria-label', `Add ${it.name} to the cart`);
    add.disabled = (cart.get(it.id) || 0) >= it.qty;
    add.addEventListener('click', () => addToCart(it));
    li.append(add);
  }
  return li;
}

function render() {
  if (mode === 'public') { renderPublic(); return; }
  $('publicHint').hidden = true;
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
    $('noResultsAdd').hidden = !q || !isStaff();
  }

  if (cashier) updateCartButton();

  // Keep an open details dialog in step with the data.
  if ($('detailDlg').open) {
    const it = items.find((x) => x.id === detailId);
    if (it) $('detailBody').replaceChildren(detailCard(it, true)); else $('detailDlg').close();
  }
}

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => { stockFilter = chip.dataset.filter; render(); });
}

const qtyPending = new Map(); // item id -> number of +/- taps still being saved

async function changeQty(id, delta) {
  const it = items.find((x) => x.id === id);
  if (!it || !isStaff()) return;
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
function openItem(item, presetBarcode) {
  if (!isStaff()) return;
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


$('scanBtn').addEventListener('click', () =>
  openScanner((code) => {
    if (mode === 'public') { lookupBarcode(code); return; }
    const found = items.find((x) => x.barcode === code);
    if (found && cashier) {
      addToCart(found); // a cashier scans straight into the cart
    } else if (found) {
      openDetails(found);
    } else if (isStaff()) {
      toast('New barcode — add the item details');
      openItem(null, code);
    } else {
      toast(`No item has barcode ${code}.`);
    }
  }),
);

$('addBtn').addEventListener('click', () => openItem(null));

// Signed-in staff and passcode viewers filter the list as they type. The
// public can only ask for one exact barcode, with Enter or the Find button.
$('search').addEventListener('input', () => {
  if (mode !== 'public') { render(); return; }
  if (lookup.state !== 'idle') { lookup = { state: 'idle', code: '', item: null, message: '' }; render(); }
});
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && mode === 'public') { e.preventDefault(); lookupBarcode($('search').value); }
});
$('lookupBtn').addEventListener('click', () => lookupBarcode($('search').value));

// Search by barcode: scan, then show only the matching item.
$('searchScan').addEventListener('click', () =>
  openScanner((code) => {
    if (mode === 'public') { lookupBarcode(code); return; }
    scannedQuery = code;
    $('search').value = code;
    render();
  }),
);

$('noResultsAdd').addEventListener('click', () => {
  const raw = $('search').value.trim();
  openItem(null, raw === scannedQuery ? raw : '');
});

// ---------- Cashier: cart and sale ----------
// A cashier passcode can take items out of stock, but only by recording a sale.
// The database prices each line (a custom price is the one thing the cashier may
// set, and it is recorded as such) and refuses to sell more than is in stock;
// the cart here is just what the cashier has rung up so far.

function saveCart() {
  try {
    sessionStorage.setItem(CART_KEY, JSON.stringify([...cart].map(([id, qty]) => [id, qty, cartPrices.has(id) ? cartPrices.get(id) : null])));
  } catch { /* cart then lasts until reload */ }
  updateCartButton();
}

function loadCart() {
  cart = new Map();
  cartPrices = new Map();
  try {
    const saved = JSON.parse(sessionStorage.getItem(CART_KEY));
    for (const [id, qty, price] of Array.isArray(saved) ? saved : []) {
      if (typeof id !== 'string' || !Number.isInteger(qty) || qty <= 0) continue;
      cart.set(id, qty);
      if (typeof price === 'number' && price >= 0) cartPrices.set(id, price);
    }
  } catch { /* start with an empty cart */ }
  updateCartButton();
}

function clearCart() {
  cart = new Map();
  cartPrices = new Map();
  try { sessionStorage.removeItem(CART_KEY); } catch { /* ignore */ }
  updateCartButton();
}

/** Cart lines for items that still exist, in the order they were added. */
function cartLines() {
  const lines = [];
  for (const [id, qty] of cart) {
    const item = items.find((x) => x.id === id);
    if (!item) continue;
    // A custom price equal to the usual one is not a custom price.
    const custom = cartPrices.has(id) && cartPrices.get(id) !== item.price;
    const price = custom ? cartPrices.get(id) : item.price;
    lines.push({ item, qty, price, custom, total: price * qty });
  }
  return lines;
}

function updateCartButton() {
  const lines = cartLines();
  const count = lines.reduce((sum, l) => sum + l.qty, 0);
  const total = lines.reduce((sum, l) => sum + l.total, 0);
  $('cartBtnText').textContent = count ? `Cart (${count}) · ${money.format(total)}` : 'Cart';
}

function addToCart(it) {
  const inCart = cart.get(it.id) || 0;
  if (it.qty <= 0) { toast(`${it.name} is out of stock`); return; }
  if (inCart >= it.qty) { toast(`Only ${it.qty} of ${it.name} in stock`); return; }
  cart.set(it.id, inCart + 1);
  saveCart();
  render();
  toast(`Added ${it.name} (${inCart + 1} in cart)`);
}

function setCartQty(id, qty) {
  if (qty <= 0) { cart.delete(id); cartPrices.delete(id); } else cart.set(id, qty);
  saveCart();
  render();
  renderCart();
}

/** Sets (or, with null, clears) the price this sale charges for one item. */
function setCartPrice(id, price) {
  if (price == null) cartPrices.delete(id); else cartPrices.set(id, price);
  saveCart();
  renderCart();
}

function cartLineRow(line, editable) {
  const { item, qty, price, custom, total } = line;
  const li = el('li', 'cart-line');
  const info = el('div');
  const sub = el('div', 'line-sub', `${qty} × ${money.format(price)}`);
  if (custom) sub.append(' ', el('span', 'usual', `usual ${money.format(item.price)}`));
  info.append(el('div', 'line-name', item.name), sub);
  li.append(info, el('div', 'line-total', money.format(total)));
  if (!editable) return li;

  const controls = el('div', 'line-controls');
  const stepper = el('div', 'qty');
  const minus = el('button', '', '−');
  minus.type = 'button';
  minus.setAttribute('aria-label', `One less ${item.name}`);
  minus.addEventListener('click', () => setCartQty(item.id, qty - 1));
  const out = el('output', '', String(qty));
  out.setAttribute('aria-label', `${qty} in cart`);
  const plus = el('button', '', '+');
  plus.type = 'button';
  plus.setAttribute('aria-label', `One more ${item.name}`);
  plus.disabled = qty >= item.qty;
  plus.addEventListener('click', () => setCartQty(item.id, qty + 1));
  stepper.append(minus, out, plus);
  const remove = el('button', 'remove', 'Remove');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Remove ${item.name} from the cart`);
  remove.addEventListener('click', () => setCartQty(item.id, 0));
  controls.append(stepper, remove);
  li.append(controls);

  // Selling this one at a different price, for this sale only.
  const priceRow = el('div', 'line-price');
  const label = el('label', '', 'Price each');
  const input = el('input');
  input.type = 'number';
  input.inputMode = 'decimal';
  input.min = '0';
  input.step = '0.01';
  input.value = String(price);
  input.id = `cartPrice-${item.id}`;
  input.setAttribute('aria-label', `Price for each ${item.name}`);
  label.htmlFor = input.id;
  input.addEventListener('change', () => {
    const text = input.value.trim();
    const value = Math.round(Number(text) * 100) / 100;
    if (text === '' || !Number.isFinite(value) || value < 0) { setCartPrice(item.id, null); return; }
    setCartPrice(item.id, value === item.price ? null : value);
  });
  priceRow.append(label, input);
  if (custom) {
    const reset = el('button', 'remove usual-btn', `Use ${money.format(item.price)}`);
    reset.type = 'button';
    reset.setAttribute('aria-label', `Use the usual price for ${item.name}`);
    reset.addEventListener('click', () => setCartPrice(item.id, null));
    priceRow.append(reset);
  }
  li.append(priceRow);
  if (qty > item.qty) li.append(el('div', 'line-warn', item.qty > 0 ? `Only ${item.qty} left in stock` : 'Now out of stock'));
  return li;
}

function renderCart() {
  const lines = cartLines();
  $('cartLines').replaceChildren(...lines.map((l) => cartLineRow(l, true)));
  $('cartEmpty').hidden = lines.length > 0;
  $('cartTotalRow').hidden = lines.length === 0;
  $('cartTotal').textContent = money.format(lines.reduce((sum, l) => sum + l.total, 0));
  $('cartConfirm').disabled = lines.length === 0;
  $('cartClear').hidden = lines.length === 0;
}

function showCartError(message) {
  $('cartError').textContent = message;
  $('cartError').hidden = !message;
}

$('cartBtn').addEventListener('click', () => {
  $('cartView').hidden = false;
  $('receiptView').hidden = true;
  showCartError('');
  renderCart();
  $('cartDlg').showModal();
  $('cartTitle').focus();
});
$('cartClose').addEventListener('click', () => $('cartDlg').close());
$('cartClear').addEventListener('click', () => { clearCart(); render(); renderCart(); });
$('receiptDone').addEventListener('click', () => $('cartDlg').close());

$('cartConfirm').addEventListener('click', async () => {
  const lines = cartLines();
  if (!lines.length || !cashier) return;
  showCartError('');
  $('cartConfirm').disabled = true;
  $('cartConfirm').textContent = 'Recording…';
  const { data, error } = await sb.rpc('record_sale', {
    p_code: passcode,
    // The price is only sent where the cashier set a custom one.
    p_lines: lines.map((l) => (l.custom ? { item_id: l.item.id, qty: l.qty, price: l.price } : { item_id: l.item.id, qty: l.qty })),
  });
  $('cartConfirm').textContent = 'Confirm sale';
  $('cartConfirm').disabled = false;

  if (error) {
    // P0001 carries a message written for the cashier, e.g. 'Only 2 left of "Soap".'
    showCartError(error.code === 'P0001' ? error.message
      : error.code === '28000' ? 'This passcode can no longer record sales. Ask an admin for a new one.'
      : explain(error, 'The sale was not recorded. Please try again.'));
    await refreshQuietly(); // stock may have changed under us
    if (mode === 'viewer') renderCart();
    return;
  }

  // Take the sold quantities off the list at once; the reload confirms them.
  for (const l of lines) l.item.qty = Math.max(0, l.item.qty - l.qty);
  $('receiptLines').replaceChildren(...lines.map((l) => cartLineRow(l, false)));
  $('receiptTotal').textContent = money.format(Number(data && data.total) || lines.reduce((sum, l) => sum + l.total, 0));
  clearCart();
  writeCache();
  render();
  $('cartView').hidden = true;
  $('receiptView').hidden = false;
  $('receiptTitle').focus();
  refreshQuietly();
});

// ---------- Passcode ----------

$('unlockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('unlockCode').value.trim().toUpperCase();
  const err = $('unlockError');
  err.hidden = true;
  if (!code) { $('unlockCode').focus(); return; }
  $('unlockBtn').disabled = true;
  const kindReply = await sb.rpc('access_code_kind', { p_code: code });
  const kind = kindReply.data;
  const { data, error } = kindReply.error || !kind
    ? { data: null, error: kindReply.error || { code: '28000' } }
    : await sb.rpc('list_items_with_code', { p_code: code });
  $('unlockBtn').disabled = false;
  if (error) {
    err.textContent = error.code === '28000' ? 'That passcode is not right. Check it and try again.' : explain(error, 'Could not check the passcode. Please try again.');
    err.hidden = false;
    return;
  }
  if (mode !== 'public') return; // signed in meanwhile
  $('unlockCode').value = '';
  stored.set(PASSCODE_KEY, code);
  stored.set(PASSCODE_KIND_KEY, kind);
  role = null;
  passcode = code;
  setMode('viewer', kind === 'cashier');
  items = (data || []).map(fromRow);
  loaded = true;
  writeCache();
  render();
  syncPhotos();
  toast(kind === 'cashier' ? 'Unlocked — you can sell from the cart' : 'Unlocked — showing all items');
});

$('lockBtn').addEventListener('click', () => {
  forgetPasscode();
  enterPublic();
  toast('Passcode forgotten on this device');
});

// ---------- Import and export (staff) ----------

const CSV_COLUMNS = ['barcode', 'name', 'description', 'price', 'qty'];

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
  if (!isStaff()) return;
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

// ---------- Start ----------

// Ask the browser not to evict our offline copy when storage is tight.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Start: show the copy saved on this device at once, then load the live list.
// ---------- Sign-in state ----------

$('signOutBtn').addEventListener('click', async () => {
  $('menuDlg').close();
  stored.remove(ROLE_KEY);
  forgetInventory(); // leave nothing behind on a shared device
  await sb.auth.signOut({ scope: 'local' });
});

let sessionSeen = false;
let sessionUserId = null;

async function applySession(session) {
  const user = (session && session.user) || null;
  const id = user ? user.id : null;
  if (sessionSeen && id === sessionUserId) return; // e.g. a token refresh
  sessionSeen = true;
  sessionUserId = id;

  if (id) {
    const { data, error } = await sb.from('profiles').select('role').eq('user_id', id).maybeSingle();
    if (sessionUserId !== id) return; // changed while we were asking
    let found = data ? data.role : null;
    if (error) {
      // Offline: trust the role this device saw last time for the same account.
      try {
        const last = JSON.parse(stored.get(ROLE_KEY));
        if (last && last.userId === id) found = last.role;
      } catch { /* none remembered */ }
    }
    if (found === 'admin' || found === 'super_admin') {
      stored.set(ROLE_KEY, JSON.stringify({ userId: id, role: found }));
      enterStaff(found, user.email);
      return;
    }
    stored.remove(ROLE_KEY);
  }

  const code = stored.get(PASSCODE_KEY);
  if (!code) { enterPublic(); return; }
  enterViewer(code, stored.get(PASSCODE_KIND_KEY));
  // The passcode may have been switched between view-only and cashier since.
  const { data: kind } = await sb.rpc('access_code_kind', { p_code: code });
  if (kind && mode === 'viewer' && passcode === code && (kind === 'cashier') !== cashier) {
    stored.set(PASSCODE_KIND_KEY, kind);
    enterViewer(code, kind);
  }
}

// Supabase must not be called from inside this callback, hence the timeout.
sb.auth.onAuthStateChange((event, session) => setTimeout(() => applySession(session), 0));

// Before roles existed the whole inventory was cached on every device. Drop
// that copy so it does not outlive the access that allowed it.
const hadOpenAccessCache = stored.get('inventory.cache.v2') !== null;
stored.remove('inventory.cache.v2');

render();
loadPhotoCache().then(() => {
  if (hadOpenAccessCache) clearPhotoCache();
  if (photos.size) render();
});
