'use strict';

// The back office: sign-in, product management with original and market
// prices, and profit. "Original price" is what the product cost to buy (stored
// as `cost`); "market price" is what it sells for (the item's `price`).
// Shared helpers (photos, scanner, form bits) are in common.js.
//
// Cost prices live in the item_costs table, which only signed-in users can
// read (see supabase/setup.sql). The inventory app never loads them.

const sb = supabase.createClient(window.INVENTORY_CONFIG.supabaseUrl, window.INVENTORY_CONFIG.supabaseKey);

/** Items as in the inventory app, plus `cost` (number, or null when not set). */
let items = [];
let loaded = false;
let userId = null;
let filter = 'all'; // 'all' | 'nocost' | 'loss'
let editingId = null;

// ---------- Profit figures ----------

const hasCost = (it) => it.cost != null;
const unitProfit = (it) => (hasCost(it) ? it.price - it.cost : null);
const stockProfit = (it) => (hasCost(it) ? (it.price - it.cost) * it.qty : null);
/** Share of the selling price that is profit, 0..1 (null when it cannot be worked out). */
const margin = (it) => (hasCost(it) && it.price > 0 ? (it.price - it.cost) / it.price : null);
const isLoss = (it) => hasCost(it) && it.price < it.cost;

const percent = (v) => `${v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(1)}%`;
const signed = (v) => (v < 0 ? `−${money.format(-v)}` : money.format(v));

// ---------- Loading ----------

function setStatus(text) {
  $('status').textContent = text;
  $('status').hidden = !text;
}

async function fetchAll(table, columns, orderBy) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(columns).order(orderBy).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function refresh() {
  const forUser = userId;
  const [itemRows, costRows] = await Promise.all([
    fetchAll('items', ITEM_COLUMNS, 'id'),
    fetchAll('item_costs', 'item_id,cost', 'item_id'),
  ]);
  if (forUser !== userId) return; // signed out meanwhile
  const costs = new Map(costRows.map((r) => [r.item_id, Number(r.cost)]));
  items = itemRows.map((r) => ({ ...fromRow(r), cost: costs.has(r.id) ? costs.get(r.id) : null }));
  loaded = true;
  render();
  syncPhotos();
}

async function refreshQuietly() {
  if (!userId) return;
  try {
    await refresh();
    setStatus('');
  } catch (e) {
    if (!userId) return;
    setStatus(explain(e, 'Could not load the products.'));
    loaded = true;
    render();
  }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshQuietly(); });
window.addEventListener('online', refreshQuietly);

// ---------- Product list ----------

function figure(label, value, className) {
  const wrap = el('div');
  const dd = el('dd', className || '', value);
  wrap.append(el('dt', '', label), dd);
  return wrap;
}

function productRow(it) {
  const li = el('li');
  const row = el('button', 'product');
  row.type = 'button';
  row.setAttribute('aria-label', `Edit ${it.name}`);

  const head = el('div', 'product-head');
  head.append(thumbFor(it));
  const text = el('div', 'item-text');
  text.append(el('div', 'item-name', it.name));
  const sub = el('div', 'item-sub');
  if (!hasCost(it)) sub.append(el('span', 'badge low', 'No original price'));
  else if (isLoss(it)) sub.append(el('span', 'badge out', 'Selling at a loss'));
  if (it.qty <= 0) sub.append(el('span', 'badge out', 'Out of stock'));
  if (sub.childNodes.length) text.append(sub);
  if (it.barcode) text.append(el('div', 'item-meta', `Barcode ${it.barcode}`));
  head.append(text);

  const up = unitProfit(it);
  const m = margin(it);
  const sp = stockProfit(it);
  const figures = el('dl', 'figures');
  figures.append(
    figure('Original', hasCost(it) ? money.format(it.cost) : '—'),
    figure('Market', money.format(it.price)),
    figure('Profit / unit', up == null ? '—' : signed(up), up != null && up < 0 ? 'neg' : ''),
    figure('Margin', m == null ? '—' : percent(m), m != null && m < 0 ? 'neg' : ''),
    figure('Stock', String(it.qty)),
    figure('Expected profit', sp == null ? '—' : signed(sp), sp != null && sp < 0 ? 'neg' : ''),
  );

  row.append(head, figures);
  row.addEventListener('click', () => openItem(it));
  li.append(row);
  return li;
}

const SORTS = {
  name: (a, b) => a.name.localeCompare(b.name),
  // Products without a cost price go last in the profit-based orders.
  profit: (a, b) => (stockProfit(b) ?? -Infinity) - (stockProfit(a) ?? -Infinity) || a.name.localeCompare(b.name),
  unit: (a, b) => (unitProfit(b) ?? -Infinity) - (unitProfit(a) ?? -Infinity) || a.name.localeCompare(b.name),
  margin: (a, b) => (margin(a) ?? Infinity) - (margin(b) ?? Infinity) || a.name.localeCompare(b.name),
  stock: (a, b) => a.qty - b.qty || a.name.localeCompare(b.name),
};

function render() {
  const raw = $('search').value.trim();
  const q = raw.toLowerCase();
  const shown = items
    .filter((it) => !q || [it.name, it.description, it.barcode].some((f) => (f || '').toLowerCase().includes(q)))
    .filter((it) => (filter === 'nocost' ? !hasCost(it) : filter === 'loss' ? isLoss(it) : true))
    .sort(SORTS[$('sort').value] || SORTS.name);

  const list = $('list');
  list.replaceChildren();
  if (!loaded) for (let i = 0; i < 4; i++) list.append(el('li', 'skeleton'));
  else for (const it of shown) list.append(productRow(it));
  list.setAttribute('aria-busy', String(!loaded));

  // Totals cover the whole inventory. Profit figures only count products that
  // have a cost price; the note says how many are left out.
  const costed = items.filter(hasCost);
  const profit = costed.reduce((sum, it) => sum + stockProfit(it), 0);
  const costedValue = costed.reduce((sum, it) => sum + it.price * it.qty, 0);
  const stockCost = costed.reduce((sum, it) => sum + it.cost * it.qty, 0);
  const stockValue = items.reduce((sum, it) => sum + it.price * it.qty, 0);
  const missing = items.length - costed.length;
  const show = loaded && costed.length > 0;
  $('statProfit').textContent = show ? signed(profit) : '–';
  $('statProfit').classList.toggle('negative', show && profit < 0);
  $('statMargin').textContent = show && costedValue > 0 ? percent(profit / costedValue) : '–';
  $('statValue').textContent = loaded ? money.format(stockValue) : '–';
  $('statCost').textContent = show ? money.format(stockCost) : '–';
  $('missingNote').textContent = loaded && missing
    ? `${missing} product${missing === 1 ? ' has' : 's have'} no original price yet and ${missing === 1 ? 'is' : 'are'} left out of the profit, margin and original-price figures.`
    : '';

  $('countAll').textContent = loaded ? String(items.length) : '';
  $('countNoCost').textContent = loaded ? String(missing) : '';
  $('countLoss').textContent = loaded ? String(items.filter(isLoss).length) : '';
  for (const chip of document.querySelectorAll('.chip')) chip.setAttribute('aria-pressed', String(chip.dataset.filter === filter));

  const filtering = Boolean(q) || filter !== 'all';
  $('summary').textContent = loaded && filtering && items.length
    ? `Showing ${shown.length} of ${items.length} product${items.length === 1 ? '' : 's'}`
    : '';
  $('empty').hidden = !loaded || items.length > 0;
  const noResults = loaded && items.length > 0 && shown.length === 0;
  $('noResults').hidden = !noResults;
  if (noResults) {
    $('noResultsText').textContent = q ? `No product matches "${raw}".`
      : filter === 'nocost' ? 'Every product has an original price.' : 'No product is selling at a loss.';
  }
}

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => { filter = chip.dataset.filter; render(); });
}
$('search').addEventListener('input', render);
$('sort').addEventListener('change', render);
$('addBtn').addEventListener('click', () => openItem(null));

// ---------- Product form ----------

function showProfitPreview() {
  const out = $('fProfit');
  const costText = $('fCost').value.trim();
  const priceText = $('fPrice').value.trim();
  out.replaceChildren();
  if (!costText || !priceText) {
    out.textContent = costText ? '' : 'Enter the original price to see the profit.';
    return;
  }
  const cost = toNumber(costText);
  const price = toNumber(priceText);
  const profit = price - cost;
  const strong = el('strong', profit < 0 ? 'neg' : '', signed(profit));
  out.append('Profit per unit: ', strong);
  if (price > 0) out.append(` (${percent(profit / price)} margin)`);
}
$('fCost').addEventListener('input', showProfitPreview);
$('fPrice').addEventListener('input', showProfitPreview);

function openItem(item) {
  editingId = item ? item.id : null;
  $('itemTitle').textContent = item ? 'Edit product' : 'Add product';
  $('fName').value = item ? item.name : '';
  $('fBarcode').value = item ? item.barcode : '';
  $('fCost').value = item && hasCost(item) ? item.cost : '';
  $('fPrice').value = item ? item.price : '';
  $('fQty').value = item ? item.qty : '';
  $('fDesc').value = item ? item.description : '';
  showFormPhoto(item ? photos.get(item.id) : null);
  formPhotoOriginal = formPhoto;
  showProfitPreview();
  $('fDelete').hidden = !item;
  $('formError').hidden = true;
  $('itemDlg').showModal();
  $(item ? 'itemTitle' : 'fName').focus();
}

/** Stores the cost price, or removes it when the field was left empty. */
async function saveCost(itemId, costText) {
  if (costText === '') {
    const { error } = await sb.from('item_costs').delete().eq('item_id', itemId);
    if (error) throw error;
    return null;
  }
  const cost = toNumber(costText);
  const { error } = await sb.from('item_costs').upsert({ item_id: itemId, cost, updated_at: new Date().toISOString() });
  if (error) throw error;
  return cost;
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
  const costText = $('fCost').value.trim();
  const before = items.find((x) => x.id === editingId);
  const isEdit = Boolean(editingId);
  $('formError').hidden = true;
  setFormBusy(true);
  try {
    const query = isEdit ? sb.from('items').update(row).eq('id', editingId) : sb.from('items').insert(row);
    const { data, error } = await query.select(ITEM_COLUMNS).single();
    if (error) return showFormError(explain(error, isEdit ? 'Could not save. The product may have been deleted by someone else.' : 'Could not save the product.'));
    let saved = { ...fromRow(data), cost: before ? before.cost : null };

    const problems = [];
    try {
      saved.cost = await saveCost(saved.id, costText);
    } catch {
      problems.push('original price');
    }
    if (formPhoto !== formPhotoOriginal) {
      try {
        saved = { ...(await savePhoto(saved, formPhoto)), cost: saved.cost };
      } catch {
        problems.push('photo');
      }
    }

    const i = items.findIndex((x) => x.id === saved.id);
    if (i >= 0) items[i] = saved; else items.push(saved);
    render();
    $('itemDlg').close();
    toast(problems.length ? `Product saved, but the ${problems.join(' and ')} could not be stored.`
      : isEdit ? 'Product updated' : 'Product added');
  } finally {
    setFormBusy(false);
  }
});

$('fDelete').addEventListener('click', async () => {
  const it = items.find((x) => x.id === editingId);
  if (!it) return;
  const yes = await confirmDialog({
    title: `Delete "${it.name}"?`,
    text: 'It will be removed from the inventory for everyone. This cannot be undone.',
    ok: 'Delete',
    danger: true,
  });
  if (!yes) return;
  setFormBusy(true);
  try {
    const { error } = await sb.from('items').delete().eq('id', it.id); // its cost and photo go with it
    if (error) return showFormError(explain(error, 'Could not delete the product.'));
    items = items.filter((x) => x.id !== it.id);
    uncachePhoto(it.id);
    render();
    $('itemDlg').close();
    toast('Product deleted');
  } finally {
    setFormBusy(false);
  }
});

// ---------- Export ----------

$('exportBtn').addEventListener('click', () => {
  const header = ['barcode', 'name', 'description', 'original_price', 'market_price', 'profit_per_unit', 'margin_percent', 'qty', 'expected_profit'];
  const num = (v) => (v == null ? '' : v.toFixed(2));
  const lines = [header.join(',')];
  for (const it of [...items].sort(SORTS.name)) {
    const m = margin(it);
    lines.push([
      it.barcode, it.name, it.description,
      num(it.cost), num(it.price), num(unitProfit(it)), m == null ? '' : (m * 100).toFixed(1), it.qty, num(stockProfit(it)),
    ].map(csvCell).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `inventory-profit-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${items.length} product${items.length === 1 ? '' : 's'}`);
});

// ---------- Sign in / out ----------

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('loginError');
  err.hidden = true;
  $('loginBtn').disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email: $('lEmail').value.trim(), password: $('lPassword').value });
  $('loginBtn').disabled = false;
  if (!error) { $('lPassword').value = ''; return; }
  err.textContent = error.code === 'invalid_credentials' ? 'Wrong email or password.'
    : error.code === 'email_not_confirmed' ? 'This account\'s email address has not been confirmed yet.'
    : explain(error, 'Could not sign in. Please try again.');
  err.hidden = false;
});

$('signOutBtn').addEventListener('click', () => sb.auth.signOut({ scope: 'local' }));

let sessionApplied = false;
function applySession(session) {
  const id = (session && session.user && session.user.id) || null;
  if (sessionApplied && id === userId) return; // e.g. a token refresh
  sessionApplied = true;
  userId = id;
  setStatus('');
  if (!id) {
    // Leave nothing about costs or profit on screen after signing out.
    items = [];
    loaded = false;
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    document.body.dataset.view = 'login';
    render();
    return;
  }
  document.body.dataset.view = 'app';
  render();
  refreshQuietly();
}

// Supabase must not be called from inside this callback, hence the timeout.
sb.auth.onAuthStateChange((event, session) => setTimeout(() => applySession(session), 0));

loadPhotoCache().then(() => { if (photos.size) render(); });
