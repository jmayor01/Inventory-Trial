'use strict';

// The back office. Needs a sign-in, and works in one store at a time (see
// "Stores" in common.js). What it shows depends on the role in that store:
//   admin       - products, original prices and profit, sales, passcodes, export
//   super admin - the same, plus the store's user accounts and new stores
// The database enforces these rules (supabase/setup.sql); hiding things here
// is only so that people are not shown buttons that would be refused.
//
// "Original price" is what a product cost to buy (stored as `cost` in the
// item_costs table); "market price" is what it sells for (the item's `price`).
// Shared helpers (photos, scanner, form bits) are in common.js.

const sb = supabase.createClient(window.INVENTORY_CONFIG.supabaseUrl, window.INVENTORY_CONFIG.supabaseKey, {
  auth: { storage: authStorage },
});

/** Items as in the inventory app, plus `cost` (number, or null when not set). */
let items = [];
let loaded = false;
let userId = null;
let role = null; // 'admin' | 'super_admin', in the current store
let store = null; // { id, name, slug, role }: the store being worked on
let myStores = []; // every store this account works at
let userEmail = '';
let myAccountId = '';

/** ABCDEF23 -> ABCD-EF23, easier to read out and type. */
const showAccountId = (code) => (code && code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code || '');
const isSuper = () => role === 'super_admin';
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

async function fetchAll(table, columns, orderBy, narrow = (q) => q) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await narrow(sb.from(table).select(columns)).order(orderBy).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function refresh() {
  const forUser = userId;
  const forStore = store && store.id;
  if (!forStore) return;
  const [itemRows, costRows] = await Promise.all([
    fetchAll('items', ITEM_COLUMNS, 'id', (q) => q.eq('store_id', forStore)),
    fetchAll('item_costs', 'item_id,cost,items!inner(store_id)', 'item_id', (q) => q.eq('items.store_id', forStore)),
  ]);
  if (forUser !== userId || !store || forStore !== store.id) return; // signed out or switched store meanwhile
  const costs = new Map(costRows.map((r) => [r.item_id, Number(r.cost)]));
  items = itemRows.map((r) => ({ ...fromRow(r), cost: costs.has(r.id) ? costs.get(r.id) : null }));
  loaded = true;
  render();
  syncPhotos();
}

async function refreshQuietly() {
  if (!userId || !role) return;
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
  for (const chip of document.querySelectorAll('.chip[data-filter]')) chip.setAttribute('aria-pressed', String(chip.dataset.filter === filter));

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

for (const chip of document.querySelectorAll('.chip[data-filter]')) {
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
    const query = isEdit ? sb.from('items').update(row).eq('id', editingId) : sb.from('items').insert({ ...row, store_id: store.id });
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

// ---------- Import from Excel or CSV ----------
// Reads a sheet with a header row, wherever that row is (a title above it is
// fine), and adds or updates products. Blank cells are accepted: a new product
// gets 0 for a blank quantity or price, and an existing one keeps what it had.

const IMPORT_COLUMNS = {
  name: ['particular', 'particulars', 'name', 'item', 'item name', 'product', 'product name', 'items', 'products'],
  qty: ['qty', 'quantity', 'stock', 'stocks', 'count', 'pcs', 'on hand'],
  cost: ['orig price', 'original price', 'orig. price', 'cost', 'cost price', 'unit cost', 'capital', 'buying price', 'purchase price'],
  price: ['srp', 'price', 'selling price', 'market price', 'retail price', 'sell price', 'unit price'],
  barcode: ['barcode', 'bar code', 'code', 'sku', 'upc', 'ean', 'item code', 'product code'],
  description: ['description', 'desc', 'notes', 'note', 'remarks', 'details'],
};

let importSheets = [];
let importPlan = null; // { rows: [...], fresh, changed }

const headerKey = (text) => String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Finds the header row (the first with a product-name column) and which column is which. */
function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const cols = {};
    (rows[r] || []).forEach((cell, c) => {
      const key = headerKey(cell);
      for (const [field, names] of Object.entries(IMPORT_COLUMNS)) {
        if (cols[field] === undefined && names.includes(key)) cols[field] = c;
      }
    });
    if (cols.name !== undefined) return { row: r, cols };
  }
  return null;
}

/** A cell as a number, or null when it is blank or not a number. */
function cellNumber(text) {
  const clean = String(text ?? '').trim().replace(/,/g, '');
  if (clean === '') return null;
  const n = Number(clean);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** A barcode cell as text. Excel may hand a long number over as 4.806E+12. */
function cellBarcode(text) {
  const clean = String(text ?? '').trim();
  if (/^\d+(\.0+)?$/.test(clean)) return clean.replace(/\.0+$/, '');
  if (/^\d(\.\d+)?e\+?\d+$/i.test(clean)) return Number(clean).toFixed(0);
  return clean;
}

function planImport(sheet) {
  const header = findHeader(sheet.rows);
  if (!header) return { error: 'No header row was found. The sheet needs a column headed Name, Particular, Item or Product.' };
  const { cols } = header;
  const cell = (row, field) => (cols[field] === undefined ? '' : String(row[cols[field]] ?? '').trim());

  const byBarcode = new Map(items.filter((it) => it.barcode).map((it) => [it.barcode, it]));
  const byName = new Map(items.map((it) => [it.name.trim().toLowerCase(), it]));
  const seen = new Map(); // key -> index in out, so a product listed twice is imported once
  const out = [];
  let noName = 0, repeated = 0;

  for (const row of sheet.rows.slice(header.row + 1)) {
    if (!row || !row.some((x) => String(x ?? '').trim() !== '')) continue;
    const name = cell(row, 'name');
    if (!name) { noName += 1; continue; }
    const barcode = cellBarcode(cell(row, 'barcode'));
    const existing = (barcode && byBarcode.get(barcode)) || byName.get(name.toLowerCase()) || null;
    const entry = {
      name, barcode,
      description: cell(row, 'description'),
      qty: cols.qty === undefined ? null : cellNumber(cell(row, 'qty')),
      price: cols.price === undefined ? null : cellNumber(cell(row, 'price')),
      cost: cols.cost === undefined ? null : cellNumber(cell(row, 'cost')),
      existing,
    };
    if (entry.qty != null) entry.qty = Math.round(entry.qty);
    const key = existing ? `id:${existing.id}` : barcode ? `b:${barcode}` : `n:${name.toLowerCase()}`;
    if (seen.has(key)) { out[seen.get(key)] = entry; repeated += 1; } else { seen.set(key, out.length); out.push(entry); }
  }

  // Two different products must not end up with the same barcode.
  const taken = new Map(items.filter((it) => it.barcode).map((it) => [it.barcode, it.id]));
  let clash = 0;
  for (const e of out) {
    if (!e.barcode) continue;
    const owner = taken.get(e.barcode);
    const me = e.existing ? e.existing.id : e;
    if (owner !== undefined && owner !== me) { e.barcode = ''; clash += 1; } else taken.set(e.barcode, me);
  }

  return {
    rows: out, cols, noName, repeated, clash,
    fresh: out.filter((e) => !e.existing).length,
    changed: out.filter((e) => e.existing).length,
  };
}

function showImportPlan() {
  const sheet = importSheets[Number($('importSheet').value) || 0];
  const plan = planImport(sheet);
  importPlan = null;
  $('importFound').hidden = true;
  $('importGo').hidden = true;
  showError('importError', '');
  if (plan.error) { showError('importError', plan.error); return; }
  if (!plan.rows.length) { showError('importError', 'No products were found under the header row.'); return; }
  importPlan = plan;

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  $('importSummary').textContent = `${plural(plan.rows.length, 'product')} found: ${plan.fresh} new, ${plan.changed} already in the inventory (will be updated).`;
  const notes = [];
  const found = Object.keys(IMPORT_COLUMNS).filter((f) => plan.cols[f] !== undefined);
  const label = { name: 'name', qty: 'quantity', cost: 'original price', price: 'market price', barcode: 'barcode', description: 'description' };
  notes.push(`Columns read: ${found.map((f) => label[f]).join(', ')}.`);
  const blank = (f) => plan.rows.filter((e) => e[f] == null).length;
  if (plan.cols.price !== undefined && blank('price')) notes.push(`${plural(blank('price'), 'product')} with no market price: new ones get 0, existing ones keep theirs.`);
  if (plan.cols.cost !== undefined && blank('cost')) notes.push(`${plural(blank('cost'), 'product')} with no original price: left without one (not counted in profit).`);
  if (plan.cols.qty !== undefined && blank('qty')) notes.push(`${plural(blank('qty'), 'product')} with no quantity: new ones get 0, existing ones keep theirs.`);
  if (plan.cols.barcode === undefined) notes.push('No barcode column. Products are matched to existing ones by name.');
  if (plan.noName) notes.push(`${plural(plan.noName, 'row')} skipped because the name is blank.`);
  if (plan.repeated) notes.push(`${plural(plan.repeated, 'product')} listed more than once: the last row is used.`);
  if (plan.clash) notes.push(`${plural(plan.clash, 'barcode')} already belong to another product and will be left off.`);
  $('importNotes').replaceChildren(...notes.map((n) => el('li', '', n)));

  const table = $('importTable');
  table.replaceChildren();
  const headRow = el('tr');
  for (const h of ['Name', 'Qty', 'Original', 'Market', 'Barcode', '']) headRow.append(el('th', '', h));
  table.append(headRow);
  const show = (v) => (v == null ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : money.format(v)) : v || '—');
  for (const e of plan.rows.slice(0, 8)) {
    const tr = el('tr');
    tr.append(el('td', '', e.name), el('td', 'num', show(e.qty)), el('td', 'num', show(e.cost)), el('td', 'num', show(e.price)), el('td', '', show(e.barcode)), el('td', '', e.existing ? 'update' : 'new'));
    table.append(tr);
  }
  if (plan.rows.length > 8) {
    const more = el('tr');
    const td = el('td', 'more', `… and ${plan.rows.length - 8} more`);
    td.colSpan = 6;
    more.append(td);
    table.append(more);
  }
  $('importFound').hidden = false;
  $('importGo').hidden = false;
  $('importGo').textContent = `Import ${plural(plan.rows.length, 'product')}`;
}

$('importBtn').addEventListener('click', () => {
  importSheets = [];
  importPlan = null;
  $('importSheetRow').hidden = true;
  $('importFound').hidden = true;
  $('importGo').hidden = true;
  $('importGenerate').checked = false;
  showError('importError', '');
  $('importDlg').showModal();
  $('importTitle').focus();
});
$('importClose').addEventListener('click', () => $('importDlg').close());
$('importPick').addEventListener('click', () => $('importFile').click());
$('importSheet').addEventListener('change', showImportPlan);

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  $('importFound').hidden = true;
  $('importGo').hidden = true;
  showError('importError', '');
  try {
    importSheets = await readWorkbook(file);
  } catch (err) {
    showError('importError', err.message || 'That file could not be read.');
    return;
  }
  const select = $('importSheet');
  select.replaceChildren(...importSheets.map((s, i) => { const o = el('option', '', s.name); o.value = String(i); return o; }));
  // Start on the first sheet that has a recognisable header row.
  const firstGood = importSheets.findIndex((s) => findHeader(s.rows));
  select.value = String(Math.max(0, firstGood));
  $('importSheetRow').hidden = importSheets.length < 2;
  showImportPlan();
});

$('importGo').addEventListener('click', async () => {
  if (!importPlan) return;
  const plan = importPlan;
  const generate = $('importGenerate').checked;
  $('importGo').disabled = true;
  $('importGo').textContent = 'Importing…';
  showError('importError', '');
  try {
    // New barcodes must differ from each other as well as from existing ones.
    const made = new Set();
    const newBarcode = () => { for (;;) { const c = generateBarcode(); if (!made.has(c)) { made.add(c); return c; } } };

    const fresh = [], updates = [], costs = [];
    for (const e of plan.rows) {
      if (e.existing) {
        const row = { id: e.existing.id, store_id: store.id, name: e.name, barcode: e.barcode || e.existing.barcode || (generate ? newBarcode() : ''), description: e.description || e.existing.description, price: e.price ?? e.existing.price, qty: e.qty ?? e.existing.qty };
        updates.push(row);
        if (e.cost != null) costs.push({ item_id: row.id, cost: e.cost, updated_at: new Date().toISOString() });
      } else {
        const row = { id: crypto.randomUUID(), store_id: store.id, name: e.name, barcode: e.barcode || (generate ? newBarcode() : ''), description: e.description, price: e.price ?? 0, qty: e.qty ?? 0 };
        fresh.push(row);
        if (e.cost != null) costs.push({ item_id: row.id, cost: e.cost, updated_at: new Date().toISOString() });
      }
    }
    const send = async (table, rows) => {
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb.from(table).upsert(rows.slice(i, i + 500));
        if (error) throw error;
      }
    };
    await send('items', fresh);
    await send('items', updates);
    await send('item_costs', costs);
    $('importDlg').close();
    toast(`Imported: ${fresh.length} added, ${updates.length} updated`);
  } catch (err) {
    showError('importError', `${explain(err, 'The import stopped part-way.')} Products saved before the problem are kept; you can import the file again safely.`);
  } finally {
    $('importGo').disabled = false;
    await refreshQuietly();
    if ($('importDlg').open) showImportPlan();
  }
});

// ---------- Barcode labels ----------
// Draws a label (name, barcode, price) as an image at the printer's own
// resolution, to be printed from the label printer's app. Sized for the
// NIIMBOT B1: 203 dots per inch, i.e. 8 dots per millimetre.

const LABEL_DOTS_PER_MM = 8;
const LABEL_SIZE_KEY = 'inventory.labelSize';
const LABEL_PARTS_KEY = 'inventory.labelParts'; // whether the name and the price are shown

/** EAN-13 when the code is a valid one, otherwise Code 128, which takes any text. */
function barcodeFormat(code) {
  if (/^\d{13}$/.test(code)) {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 ? 3 : 1);
    if ((10 - (sum % 10)) % 10 === Number(code[12])) return 'EAN13';
  }
  return 'CODE128';
}

/** Shortens text with an ellipsis until it fits the width. */
function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

/** Draws the label; returns an error message, or '' when it worked. */
function drawLabel(canvas = $('labelCanvas'), maxWidth = Infinity) {
  const [wMm, hMm] = $('labelSize').value.split('x').map(Number);
  // maxWidth is the printer's print head when printing directly: a B1 prints
  // 48 mm across, so a 50 mm label is drawn 48 mm wide and sits centred.
  const W = Math.min(wMm * LABEL_DOTS_PER_MM, maxWidth);
  const H = hMm * LABEL_DOTS_PER_MM;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const code = $('fBarcode').value.trim();
  const name = $('fName').value.trim();
  const showName = $('labelName').checked && name;
  const showPrice = $('labelPrice').checked;
  const pad = Math.round(1.5 * LABEL_DOTS_PER_MM);
  const small = H <= 20 * LABEL_DOTS_PER_MM; // short labels get smaller text
  const nameSize = small ? 20 : 26;
  const priceSize = small ? 26 : 36;
  let top = pad;
  let bottom = H - pad;

  if (showName) {
    ctx.font = `bold ${nameSize}px Arial, Helvetica, sans-serif`;
    ctx.fillText(fitText(ctx, name, W - 2 * pad), W / 2, top);
    top += nameSize + 4;
  }
  if (showPrice) {
    ctx.font = `bold ${priceSize}px Arial, Helvetica, sans-serif`;
    bottom -= priceSize;
    ctx.fillText(fitText(ctx, money.format(toNumber($('fPrice').value)), W - 2 * pad), W / 2, bottom);
    bottom -= 4;
  }

  // The barcode takes the space that is left. Bars are whole printer dots wide
  // (never scaled), which is what keeps them scannable once printed.
  const digits = small ? 18 : 22;
  const space = bottom - top;
  const format = barcodeFormat(code);
  const scratch = document.createElement('canvas');
  for (let dot = 4; dot >= 1; dot--) {
    try {
      JsBarcode(scratch, code, {
        format, width: dot, height: Math.max(24, space - digits - 6), margin: 0,
        displayValue: true, fontSize: digits, textMargin: 2, font: 'Arial, Helvetica, sans-serif', fontOptions: 'bold',
        background: '#ffffff', lineColor: '#000000',
      });
    } catch {
      return 'This barcode cannot be drawn. Use letters and numbers only.';
    }
    // Leave a clear margin either side; scanners need it.
    if (scratch.width <= W - 2 * pad - 4 * dot) {
      ctx.drawImage(scratch, Math.round((W - scratch.width) / 2), top + Math.max(0, Math.round((space - scratch.height) / 2)));
      return '';
    }
  }
  return 'This barcode is too long for the label. Choose a bigger label size.';
}

function refreshLabel() {
  const message = drawLabel();
  showError('labelError', message);
  $('labelDownload').disabled = Boolean(message);
  $('labelShare').disabled = Boolean(message);
  $('labelPrint').disabled = Boolean(message);
  try {
    localStorage.setItem(LABEL_SIZE_KEY, $('labelSize').value);
    localStorage.setItem(LABEL_PARTS_KEY, JSON.stringify({ name: $('labelName').checked, price: $('labelPrice').checked }));
  } catch { /* not remembered */ }
}

function labelFile() {
  return new Promise((resolve) => {
    $('labelCanvas').toBlob((blob) => {
      const safe = ($('fName').value.trim() || 'label').replace(/[^\w-]+/g, '-').slice(0, 40);
      resolve(new File([blob], `label-${safe}.png`, { type: 'image/png' }));
    }, 'image/png');
  });
}

$('fLabel').addEventListener('click', () => {
  if (!$('fBarcode').value.trim()) {
    showFormError('Enter, scan or generate a barcode first.', $('fBarcode'));
    return;
  }
  try {
    const saved = localStorage.getItem(LABEL_SIZE_KEY);
    if (saved && [...$('labelSize').options].some((o) => o.value === saved)) $('labelSize').value = saved;
    const parts = JSON.parse(localStorage.getItem(LABEL_PARTS_KEY));
    if (parts) { $('labelName').checked = parts.name !== false; $('labelPrice').checked = parts.price !== false; }
  } catch { /* use the default size */ }
  // Sharing an image file straight to another app only exists on phones.
  const probe = new File([''], 'label.png', { type: 'image/png' });
  $('labelShare').hidden = !(navigator.canShare && navigator.canShare({ files: [probe] }));
  $('labelDirect').hidden = !canPrintDirect();
  $('labelNoDirect').hidden = canPrintDirect();
  setPrintStatus('');
  refreshLabel();
  $('labelDlg').showModal();
  $('labelTitle').focus();
});
for (const id of ['labelSize', 'labelName', 'labelPrice']) $(id).addEventListener('change', refreshLabel);
$('labelClose').addEventListener('click', () => $('labelDlg').close());

$('labelDownload').addEventListener('click', async () => {
  const file = await labelFile();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Label image saved');
});

// ---- Printing straight to a NIIMBOT printer over Bluetooth ----
// Works where the browser can talk to Bluetooth devices: Chrome or Edge on
// Android and on computers, not on iPhone or iPad. It uses NiimBlueLib, a
// community library (NIIMBOT publishes no official way), so sharing the image
// to the NIIMBOT app stays available as the dependable route.

let labelPrinter = null; // stays connected between labels

const canPrintDirect = () => Boolean(navigator.bluetooth) && typeof niimbluelib !== 'undefined';

function setPrintStatus(text) {
  $('labelStatus').textContent = text;
  $('labelStatus').hidden = !text;
}

async function printLabelDirect() {
  const copies = Math.min(50, Math.max(1, Math.round(Number($('labelCopies').value) || 1)));
  $('labelCopies').value = String(copies);
  showError('labelError', '');
  $('labelPrint').disabled = true;
  try {
    if (!labelPrinter || !labelPrinter.isConnected()) {
      setPrintStatus('Choose your printer in the list that opens…');
      const client = new niimbluelib.NiimbotBluetoothClient();
      await client.connect(); // shows the browser's own list of nearby printers
      labelPrinter = client;
    }
    const meta = labelPrinter.getModelMetadata() || {};
    const taskName = labelPrinter.getPrintTaskType() || 'B1';

    // Draw the label again at the width this printer can actually print.
    const canvas = document.createElement('canvas');
    const problem = drawLabel(canvas, meta.printheadPixels || 384);
    if (problem) throw new Error(problem);
    const image = niimbluelib.ImageEncoder.encodeCanvas(canvas, niimbluelib.PageColorType.SingleColor, meta.printDirection || 'top');

    setPrintStatus(`Printing ${copies} label${copies === 1 ? '' : 's'}…`);
    const task = labelPrinter.protocol.newPrintTask(taskName, {
      totalPages: copies,
      density: meta.densityDefault || 3,
      labelType: niimbluelib.LabelType.WithGaps,
      statusPollIntervalMs: 200,
      statusTimeoutMs: 15000,
    });
    try {
      await task.printInit();
      await task.printPage(image, copies);
      await task.waitForFinished();
    } finally {
      await labelPrinter.protocol.printEnd().catch(() => {});
    }
    setPrintStatus('');
    toast(`Printed ${copies} label${copies === 1 ? '' : 's'}`);
  } catch (e) {
    setPrintStatus('');
    const name = (e && e.name) || '';
    if (name === 'NotFoundError') return; // the printer list was closed without choosing
    if (labelPrinter && !labelPrinter.isConnected()) labelPrinter = null;
    const reason = (e && e.message) || 'unknown problem';
    showError('labelError', name === 'SecurityError' || name === 'NotAllowedError'
      ? 'Bluetooth is not allowed here. Allow Bluetooth (and, on Android, Location) for the browser, then try again.'
      : `Could not print directly (${reason}). Check that the printer is on, has labels and is not connected to the NIIMBOT app, or use Share / Save image instead.`);
  } finally {
    $('labelPrint').disabled = false;
  }
}

$('labelPrint').addEventListener('click', printLabelDirect);
window.addEventListener('pagehide', () => { if (labelPrinter) labelPrinter.disconnect().catch(() => {}); });

$('labelShare').addEventListener('click', async () => {
  try {
    await navigator.share({ files: [await labelFile()], title: 'Barcode label' });
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('Could not share. Use Save image instead.');
  }
});

// ---------- Export ----------

// The file follows the shop's own inventory sheet: a title row, then
// Qty | Particular | Orig Price | SRP | Profit | TOTAL, plus Barcode. Profit and
// TOTAL are formulas, as in that sheet, so they follow any edits made in Excel.
// The same file can be imported again with the Import button.
const EXPORT_CURRENCY = '₱';

$('exportBtn').addEventListener('click', () => {
  const S = XLSX_STYLE;
  const today = new Date();
  const title = `${store.name.toUpperCase()} — INVENTORY as of ${today.toLocaleDateString(undefined, { dateStyle: 'medium' })}`;
  const headers = ['Qty', 'Particular', 'Orig Price', 'SRP', 'Profit', 'TOTAL', 'Barcode'];
  const rows = [
    [{ text: title, style: S.title }, ...headers.slice(1).map(() => ({ text: '', style: S.title }))],
    headers.map((h) => ({ text: h, style: S.header })),
  ];
  const sorted = [...items].sort(SORTS.name);
  sorted.forEach((it, i) => {
    const r = i + 3; // the sheet row this product is on
    const profit = unitProfit(it);
    rows.push([
      { number: it.qty, style: S.number },
      { text: it.name, style: S.text },
      hasCost(it) ? { number: it.cost, style: S.number } : { text: '', style: S.number },
      { number: it.price, style: S.number },
      // Blank when there is no original price, rather than a misleading figure.
      { formula: `IF(OR(C${r}="",D${r}=""),0,D${r}-C${r})`, number: profit == null ? 0 : Math.round(profit * 100) / 100, style: S.number },
      { formula: `A${r}*D${r}`, number: Math.round(it.qty * it.price * 100) / 100, style: S.money },
      { text: it.barcode || '', style: S.text },
    ]);
  });
  const blob = makeXlsx({
    sheetName: 'Inventory',
    rows,
    widths: [8, 42, 12, 12, 12, 16, 20],
    merges: ['A1:G1'],
    currency: EXPORT_CURRENCY,
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `inventory-${store.slug}-${today.toISOString().slice(0, 10)}.xlsx`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${items.length} product${items.length === 1 ? '' : 's'}`);
});


// ---------- Sign in / out ----------

const MAX_WRONG_PASSWORDS = 10;

function restMessage(seconds) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Too many wrong passwords for this account. Wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`;
}

/**
 * Signs in with a password, counting wrong ones per account: after 10 in 15
 * minutes the account rests. Returns { ok: true } or { ok: false, message }.
 */
async function passwordSignIn(email, password) {
  const before = await sb.rpc('login_status', { p_email: email });
  if (before.data && before.data.locked) return { ok: false, message: restMessage(before.data.wait_seconds) };

  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (!error) {
    sb.rpc('login_succeeded').then(() => {}, () => {}); // clear the count; nothing depends on the answer
    return { ok: true };
  }
  if (error.code !== 'invalid_credentials') {
    return { ok: false, message: error.code === 'email_not_confirmed' ? 'This account\'s email address has not been confirmed yet.' : explain(error, 'Could not sign in. Please try again.') };
  }
  const after = await sb.rpc('login_failed', { p_email: email });
  if (after.data && after.data.locked) return { ok: false, message: restMessage(after.data.wait_seconds), wrongPassword: true };
  const left = after.data ? MAX_WRONG_PASSWORDS - after.data.failed : null;
  return { ok: false, wrongPassword: true, left };
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('loginError');
  err.hidden = true;
  const email = $('lEmail').value.trim();
  if (!email || !$('lPassword').value) { err.textContent = 'Enter your email and password.'; err.hidden = false; return; }
  $('loginBtn').disabled = true;
  setRemember($('lRemember').checked); // decides where the sign-in is kept
  const result = await passwordSignIn(email, $('lPassword').value);
  $('loginBtn').disabled = false;
  $('lPassword').value = '';
  if (result.ok) return;
  err.textContent = result.message
    || `Wrong email or password.${result.left != null && result.left <= 5 ? ` ${result.left} attempt${result.left === 1 ? '' : 's'} left before a 15-minute wait.` : ''}`;
  err.hidden = false;
});

// ---------- Sections ----------

let currentTab = 'products';

function showTab(name) {
  currentTab = name === 'users' && !isSuper() ? 'products' : name; // only the super admin manages users
  for (const tab of document.querySelectorAll('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.tab === currentTab));
  for (const panel of document.querySelectorAll('.tabpanel')) panel.hidden = panel.id !== `tab-${currentTab}`;
  if (currentTab === 'sales') loadSales();
  if (currentTab === 'users') loadUsers();
  if (currentTab === 'codes') loadCodes();
  if (currentTab === 'store') showStoreTab();
  if (currentTab === 'profile') showProfileTab();
}
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => showTab(tab.dataset.tab));

function showError(id, message) {
  $(id).textContent = message;
  $(id).hidden = !message;
}

// ---------- Password check ----------

/**
 * Asks the signed-in user for their password before a sensitive change and
 * resolves to true once it has been checked with Supabase. Stops someone who
 * picks up an unlocked, signed-in device from altering the sales records.
 */
function confirmWithPassword({ title, text, ok, danger }) {
  return new Promise((resolve) => {
    const dlg = $('passwordDlg');
    $('passwordTitle').textContent = title;
    $('passwordText').textContent = text;
    $('passwordEmail').textContent = userEmail;
    $('passwordOk').textContent = ok;
    $('passwordOk').className = danger ? 'btn danger solid' : 'btn primary';
    $('passwordInput').value = '';
    showError('passwordError', '');
    let passed = false;

    const onSubmit = async (e) => {
      e.preventDefault();
      const password = $('passwordInput').value;
      if (!password) { showError('passwordError', 'Enter your password.'); $('passwordInput').focus(); return; }
      $('passwordOk').disabled = true;
      // Signing in again as the same account is how the password gets checked.
      const result = await passwordSignIn(userEmail, password);
      $('passwordOk').disabled = false;
      if (!result.ok) {
        showError('passwordError', result.message
          || `That password is not right.${result.left != null && result.left <= 5 ? ` ${result.left} attempt${result.left === 1 ? '' : 's'} left before a 15-minute wait.` : ''}`);
        $('passwordInput').select();
        return;
      }
      passed = true;
      dlg.close();
    };
    const onCancel = () => dlg.close();
    const onClose = () => {
      $('passwordForm').removeEventListener('submit', onSubmit);
      $('passwordCancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('close', onClose);
      $('passwordInput').value = '';
      resolve(passed);
    };
    $('passwordForm').addEventListener('submit', onSubmit);
    $('passwordCancel').addEventListener('click', onCancel);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    $('passwordInput').focus();
  });
}

// ---------- Sales ----------
// What cashiers actually sold, and the profit on it. Each sale line carries the
// market and original price as they were at the time of the sale.

let salesPeriod = 'today';
const SALES_LIMIT = 1000;

function periodStart() {
  const now = new Date();
  if (salesPeriod === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (salesPeriod === 'all') return null;
  return new Date(now.getTime() - Number(salesPeriod) * 24 * 60 * 60 * 1000);
}

async function loadSales() {
  for (const chip of document.querySelectorAll('.chip[data-period]')) chip.setAttribute('aria-pressed', String(chip.dataset.period === salesPeriod));
  const forPeriod = salesPeriod;
  let query = sb.from('sales')
    .select('id,created_at,sold_by,total,voided_at,voided_by,edited_at,edited_by,sale_lines(id,name,qty,price,list_price,cost)')
    .eq('store_id', store.id)
    .order('created_at', { ascending: false })
    .limit(SALES_LIMIT);
  const from = periodStart();
  if (from) query = query.gte('created_at', from.toISOString());
  const { data, error } = await query;
  if (forPeriod !== salesPeriod || currentTab !== 'sales') return;
  if (error) { setStatus(explain(error, 'Could not load the sales.')); return; }
  setStatus('');

  let revenue = 0, profit = 0, units = 0, count = 0, uncosted = 0;
  const list = $('salesList');
  list.replaceChildren();
  for (const sale of data) {
    const lines = sale.sale_lines || [];
    let saleProfit = 0, saleUncosted = 0;
    for (const l of lines) {
      if (l.cost == null) saleUncosted += l.qty; else saleProfit += (Number(l.price) - Number(l.cost)) * l.qty;
    }
    const voided = Boolean(sale.voided_at);
    if (!voided) {
      count += 1;
      revenue += Number(sale.total);
      profit += saleProfit;
      uncosted += saleUncosted;
      units += lines.reduce((sum, l) => sum + l.qty, 0);
    }

    const li = el('li', 'row-card');
    const main = el('div', 'row-main');
    const when = new Date(sale.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const title = el('div', 'row-title', `${money.format(Number(sale.total))} · ${sale.sold_by || 'Cashier'}`);
    if (voided) { title.classList.add('struck'); title.append(' ', el('span', 'badge out', 'Cancelled')); }
    main.append(title);
    // A line sold at a custom price says so, with the usual price beside it.
    const isCustom = (l) => l.list_price != null && Number(l.list_price) !== Number(l.price);
    if (lines.some(isCustom)) title.append(' ', el('span', 'badge low', 'Custom price'));
    main.append(el('div', 'hint', lines.map((l) => (isCustom(l)
      ? `${l.qty} × ${l.name} at ${money.format(Number(l.price))} (usual ${money.format(Number(l.list_price))})`
      : `${l.qty} × ${l.name}`)).join(', ')));
    const detail = voided
      ? `${when} · cancelled${sale.voided_by ? ` by ${sale.voided_by}` : ''}`
      : `${when} · profit ${signed(saleProfit)}${saleUncosted ? ' (some items had no original price)' : ''}${sale.edited_at ? ` · edited${sale.edited_by ? ` by ${sale.edited_by}` : ''}` : ''}`;
    main.append(el('div', 'hint', detail));
    li.append(main);
    if (!voided) {
      const actions = el('div', 'row-actions');
      const cancel = el('button', 'btn danger', 'Cancel sale');
      cancel.type = 'button';
      cancel.setAttribute('aria-label', `Cancel the sale of ${money.format(Number(sale.total))} made ${when}`);
      cancel.addEventListener('click', async () => {
        const yes = await confirmWithPassword({
          title: 'Cancel this sale?',
          text: 'Its items go back into stock and it no longer counts towards sales and profit. This cannot be undone. Enter your password to confirm.',
          ok: 'Cancel sale',
          danger: true,
        });
        if (!yes) return;
        cancel.disabled = true;
        const { error: e } = await sb.rpc('void_sale', { p_sale_id: sale.id });
        toast(e ? (e.code === 'P0001' ? e.message : explain(e, 'Could not cancel the sale.')) : 'Sale cancelled and stock restored');
        loadSales();
        refreshQuietly();
      });
      const edit = el('button', 'btn', 'Edit');
      edit.type = 'button';
      edit.setAttribute('aria-label', `Edit the sale of ${money.format(Number(sale.total))} made ${when}`);
      edit.addEventListener('click', () => openSale(sale, when));
      actions.append(edit, cancel);
      li.append(actions);
    }
    list.append(li);
  }

  $('salesProfit').textContent = signed(profit);
  $('salesProfit').classList.toggle('negative', profit < 0);
  $('salesRevenue').textContent = money.format(revenue);
  $('salesCount').textContent = String(count);
  $('salesUnits').textContent = String(units);
  const notes = [];
  if (uncosted) notes.push(`${uncosted} sold item${uncosted === 1 ? ' had' : 's had'} no original price and ${uncosted === 1 ? 'is' : 'are'} left out of the profit.`);
  if (data.length === SALES_LIMIT) notes.push(`Only the latest ${SALES_LIMIT} sales are shown; choose a shorter period for exact totals.`);
  $('salesNote').textContent = notes.join(' ');
  $('salesEmpty').hidden = data.length > 0;
}

// ---- Correcting a sale ----

let editingSale = null;

function saleEdits() {
  return [...$('saleLines').querySelectorAll('.cart-line')].map((row) => ({
    line_id: row.dataset.lineId,
    qty: Math.round(Number(row.querySelector('.sale-qty').value)),
    price: Math.round(Number(row.querySelector('.sale-price').value) * 100) / 100,
  }));
}

function updateSaleTotal() {
  const total = saleEdits().reduce((sum, l) => sum + (Number.isFinite(l.qty * l.price) ? l.qty * l.price : 0), 0);
  $('saleTotal').textContent = money.format(total);
}

function openSale(sale, when) {
  editingSale = sale;
  $('saleWhen').textContent = `${when} · ${sale.sold_by || 'Cashier'}`;
  showError('saleError', '');
  const rows = (sale.sale_lines || []).map((l) => {
    const li = el('li', 'cart-line');
    li.dataset.lineId = l.id;
    const usual = l.list_price != null && Number(l.list_price) !== Number(l.price) ? ` · usual ${money.format(Number(l.list_price))}` : '';
    li.append(el('div', 'line-name', l.name), el('div', 'line-sub', `was ${l.qty} × ${money.format(Number(l.price))}${usual}`));
    const fields = el('div', 'sale-fields');
    const field = (labelText, className, value, step) => {
      const wrap = el('label', '', labelText);
      const input = el('input', className);
      input.type = 'number';
      input.inputMode = step === '1' ? 'numeric' : 'decimal';
      input.min = '0';
      input.step = step;
      input.value = String(value);
      input.addEventListener('input', updateSaleTotal);
      wrap.append(input);
      return wrap;
    };
    fields.append(field('Quantity', 'sale-qty', l.qty, '1'), field('Price each', 'sale-price', Number(l.price), '0.01'));
    li.append(fields);
    return li;
  });
  $('saleLines').replaceChildren(...rows);
  updateSaleTotal();
  $('saleDlg').showModal();
  $('saleTitle').focus();
}

$('saleCancel').addEventListener('click', () => $('saleDlg').close());

$('saleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editingSale) return;
  const edits = saleEdits();
  showError('saleError', '');
  if (edits.some((l) => !Number.isInteger(l.qty) || l.qty < 0)) { showError('saleError', 'Every quantity must be a whole number, 0 or more.'); return; }
  if (edits.some((l) => !Number.isFinite(l.price) || l.price < 0)) { showError('saleError', 'Every price must be 0 or more.'); return; }
  if (edits.every((l) => l.qty === 0)) { showError('saleError', 'A sale needs at least one item. Use Cancel sale to undo the whole sale.'); return; }
  // Only send the lines that actually changed.
  const before = new Map((editingSale.sale_lines || []).map((l) => [l.id, l]));
  const changed = edits.filter((l) => { const b = before.get(l.line_id); return !b || b.qty !== l.qty || Number(b.price) !== l.price; });
  if (!changed.length) { $('saleDlg').close(); return; }
  const sure = await confirmWithPassword({
    title: 'Save changes to this sale?',
    text: 'The sale and the stock will be updated. Enter your password to confirm.',
    ok: 'Save changes',
  });
  if (!sure) return;
  $('saleSave').disabled = true;
  $('saleSave').textContent = 'Saving…';
  const { error } = await sb.rpc('edit_sale', { p_sale_id: editingSale.id, p_lines: changed });
  $('saleSave').disabled = false;
  $('saleSave').textContent = 'Save changes';
  if (error) { showError('saleError', error.code === 'P0001' ? error.message : explain(error, 'Could not save the changes.')); return; }
  $('saleDlg').close();
  toast('Sale updated and stock adjusted');
  loadSales();
  refreshQuietly();
});

for (const chip of document.querySelectorAll('.chip[data-period]')) {
  chip.addEventListener('click', () => { salesPeriod = chip.dataset.period; loadSales(); });
}

// ---------- Users (super admin) ----------

const ROLE_NAMES = { admin: 'Admin', super_admin: 'Super admin' };

/** Calls the manage-users server function, which holds the key needed to create accounts. */
async function manageUsers(body) {
  const { data, error } = await sb.functions.invoke('manage-users', { body: { ...body, store_id: store.id } });
  if (!error) return data;
  let message = '';
  try {
    message = (await error.context.json()).error || '';
  } catch { /* no readable reply */ }
  throw new Error(message || explain(error, 'The user service did not answer. Please try again.'));
}

async function loadUsers() {
  const forStore = store.id;
  const { data: rows, error } = await sb.from('store_members')
    .select('user_id, role, created_at, profiles(email, account_code, display_name)')
    .eq('store_id', forStore).order('created_at');
  if (forStore !== store.id) return;
  if (error) { setStatus(explain(error, 'Could not load the users.')); return; }
  const data = rows.map((r) => ({ user_id: r.user_id, role: r.role, email: (r.profiles && r.profiles.email) || '', code: (r.profiles && r.profiles.account_code) || '', name: (r.profiles && r.profiles.display_name) || '' }));
  const list = $('userList');
  list.replaceChildren();
  for (const u of data) {
    const mine = u.user_id === userId;
    const li = el('li', 'row-card');
    const main = el('div', 'row-main');
    main.append(el('div', 'row-title', u.name ? `${u.name} (${u.email})` : u.email || '(no email)'), el('div', 'hint', `${mine ? `${ROLE_NAMES[u.role]} · you` : ROLE_NAMES[u.role]}${u.code ? ` · ID ${showAccountId(u.code)}` : ''}`));
    li.append(main);
    // Anyone who forgot their password gets a new one here, the super admin included.
    const reset = el('button', 'btn', mine ? 'My profile' : 'Reset password');
    reset.type = 'button';
    reset.setAttribute('aria-label', mine ? 'Open my profile' : `Reset the password of ${u.email}`);
    reset.addEventListener('click', () => (mine ? showTab('profile') : openReset(u)));
    if (mine) {
      const actions = el('div', 'row-actions');
      actions.append(reset);
      li.append(actions);
    }
    if (!mine) {
      const actions = el('div', 'row-actions');
      const select = el('select');
      select.setAttribute('aria-label', `Role of ${u.email}`);
      for (const [value, name] of Object.entries(ROLE_NAMES)) {
        const opt = el('option', '', name);
        opt.value = value;
        opt.selected = value === u.role;
        select.append(opt);
      }
      select.addEventListener('change', async () => {
        const { data: changed, error: e } = await sb.from('store_members').update({ role: select.value }).eq('store_id', store.id).eq('user_id', u.user_id).select('user_id');
        if (e || !changed.length) toast(explain(e, 'Could not change the role.'));
        else toast(`${u.email} is now ${ROLE_NAMES[select.value].toLowerCase()}`);
        loadUsers();
      });
      const remove = el('button', 'btn danger', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${u.email}`);
      remove.addEventListener('click', async () => {
        const yes = await confirmDialog({
          title: `Remove ${u.email} from ${store.name}?`,
          text: 'They lose access to this store. If they work at another store, they keep that; if not, their account is deleted.',
          ok: 'Remove',
          danger: true,
        });
        if (!yes) return;
        remove.disabled = true;
        try {
          const result = await manageUsers({ action: 'remove', user_id: u.user_id });
          toast(result && result.deleted ? 'Removed, and their account deleted' : `Removed from ${store.name}`);
        } catch (e) {
          toast(e.message);
        }
        loadUsers();
      });
      actions.append(select, reset, remove);
      li.append(actions);
    }
    list.append(li);
  }
}

// ---- Resetting a password ----

let resetUser = null;

/** A random password without look-alike characters. */
function randomPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const r of crypto.getRandomValues(new Uint8Array(12))) out += alphabet[r % alphabet.length];
  return out;
}

function openReset(user) {
  resetUser = user;
  $('resetEmail').textContent = user.email;
  $('resetPassword').value = '';
  showError('resetError', '');
  $('resetDlg').showModal();
  $('resetPassword').focus();
}

$('resetRandom').addEventListener('click', () => { $('resetPassword').value = randomPassword(); });
$('resetCancel').addEventListener('click', () => $('resetDlg').close());

$('resetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!resetUser) return;
  const password = $('resetPassword').value;
  showError('resetError', '');
  if (password.length < 8) { showError('resetError', 'The password needs at least 8 characters.'); $('resetPassword').focus(); return; }
  // Changing someone's password is as sensitive as it gets: confirm it is really you.
  const sure = await confirmWithPassword({
    title: `Set a new password for ${resetUser.email}?`,
    text: 'Enter your own current password to confirm.',
    ok: 'Set password',
  });
  if (!sure) return;
  $('resetSave').disabled = true;
  try {
    await manageUsers({ action: 'set_password', user_id: resetUser.user_id, password });
    $('resetPassword').value = '';
    $('resetDlg').close();
    toast(`New password set for ${resetUser.email}`);
  } catch (err) {
    showError('resetError', err.message);
  } finally {
    $('resetSave').disabled = false;
  }
});

$('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const who = $('uEmail').value.trim();
  const password = $('uPassword').value;
  showError('userError', '');
  const isEmail = who.includes('@');
  if (isEmail && !/^\S+@\S+\.\S+$/.test(who)) { showError('userError', 'Enter a valid email address.'); $('uEmail').focus(); return; }
  if (!isEmail && !/^[A-Za-z0-9]{8}$/.test(who.replace(/[\s-]/g, ''))) { showError('userError', 'Enter an email address or an 8-character account ID.'); $('uEmail').focus(); return; }
  if (password && password.length < 8) { showError('userError', 'The password needs at least 8 characters.'); $('uPassword').focus(); return; }
  $('userSave').disabled = true;
  $('userSave').textContent = 'Adding…';
  try {
    const result = await manageUsers({ action: 'add', who, password: isEmail ? password : '', role: $('uRole').value });
    $('userForm').reset();
    const name = (result && result.user && result.user.email) || who;
    toast(result && result.existing ? `${name} added to ${store.name} with their own password` : `Account created for ${name}`);
    loadUsers();
  } catch (err) {
    showError('userError', err.message);
  } finally {
    $('userSave').disabled = false;
    $('userSave').textContent = 'Add to store';
  }
});

// ---------- Passcodes ----------

/** A random passcode without look-alike characters (no 0/O, 1/I/L). */
function randomCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const r of crypto.getRandomValues(new Uint8Array(8))) out += alphabet[r % alphabet.length];
  return out;
}

async function loadCodes() {
  const { data, error } = await sb.from('access_codes').select('id,code,label,kind,created_at').eq('store_id', store.id).order('created_at');
  if (error) { setStatus(explain(error, 'Could not load the passcodes.')); return; }
  const list = $('codeList');
  list.replaceChildren();
  if (!data.length) list.append(el('li', 'hint', 'No passcodes yet. Until you create one, nobody can view the list without signing in.'));
  for (const c of data) {
    const li = el('li', 'row-card');
    const main = el('div', 'row-main');
    const kindBadge = el('span', c.kind === 'cashier' ? 'badge low' : 'badge plain', c.kind === 'cashier' ? 'Cashier' : 'View only');
    const note = el('div', 'hint', c.label ? `${c.label} · ` : '');
    note.append(kindBadge);
    main.append(el('div', 'code-value', c.code), note);
    const actions = el('div', 'row-actions');
    const copy = el('button', 'btn', 'Copy');
    copy.type = 'button';
    copy.setAttribute('aria-label', `Copy passcode ${c.code}`);
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(c.code);
        toast('Passcode copied');
      } catch {
        toast('Could not copy. Select the code and copy it by hand.');
      }
    });
    const del = el('button', 'btn danger', 'Delete');
    del.type = 'button';
    del.setAttribute('aria-label', `Delete passcode ${c.code}`);
    del.addEventListener('click', async () => {
      const yes = await confirmDialog({
        title: `Delete passcode ${c.code}?`,
        text: 'Anyone using it will lose access the next time the app reloads. Sales already made with it stay in the records.',
        ok: 'Delete',
        danger: true,
      });
      if (!yes) return;
      const { error: e } = await sb.from('access_codes').delete().eq('id', c.id);
      toast(e ? explain(e, 'Could not delete the passcode.') : 'Passcode deleted');
      loadCodes();
    });
    // Switch an existing passcode between view-only and cashier.
    const kind = el('select');
    kind.setAttribute('aria-label', `What passcode ${c.code} can do`);
    for (const [value, name] of [['view', 'View only'], ['cashier', 'Cashier']]) {
      const opt = el('option', '', name);
      opt.value = value;
      opt.selected = value === c.kind;
      kind.append(opt);
    }
    kind.addEventListener('change', async () => {
      const { data: changed, error: e } = await sb.from('access_codes').update({ kind: kind.value }).eq('id', c.id).select('id');
      toast(e || !changed.length ? explain(e, 'Could not change the passcode.')
        : kind.value === 'cashier' ? `${c.code} can now record sales` : `${c.code} is now view only`);
      loadCodes();
    });
    actions.append(kind, copy, del);
    li.append(main, actions);
    list.append(li);
  }
}

$('cRandom').addEventListener('click', () => { $('cCode').value = randomCode(); });

$('codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('cCode').value.trim().toUpperCase();
  showError('codeError', '');
  if (!/^[A-Z0-9]{8,64}$/.test(code)) { showError('codeError', 'Use 8 or more letters and numbers, with no spaces. A longer passcode is harder to guess.'); $('cCode').focus(); return; }
  $('codeSave').disabled = true;
  const { error } = await sb.from('access_codes').insert({ store_id: store.id, code, label: $('cLabel').value.trim(), kind: $('cKind').value });
  $('codeSave').disabled = false;
  if (error) { showError('codeError', error.code === '23505' ? 'That passcode already exists.' : explain(error, 'Could not create the passcode.')); return; }
  $('cLabel').value = '';
  $('cCode').value = randomCode();
  toast(`Passcode ${code} created`);
  loadCodes();
});

// ---------- Stores ----------

function showStoreTab() {
  $('storeLinkText').value = storeLink(store.slug);
  $('storeNameInput').value = store.name;
  showError('storeRenameError', '');
  showError('newStoreError', '');
}

$('storeLinkCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('storeLinkText').value);
    toast('Link copied');
  } catch {
    $('storeLinkText').select();
    toast('Select the link and copy it by hand.');
  }
});

$('storeRenameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('storeNameInput').value.trim();
  showError('storeRenameError', '');
  if (!name) { showError('storeRenameError', 'Give the store a name.'); return; }
  $('storeRenameSave').disabled = true;
  const { data, error } = await sb.from('stores').update({ name }).eq('id', store.id).select('id');
  $('storeRenameSave').disabled = false;
  if (error || !data.length) { showError('storeRenameError', explain(error, 'Could not rename the store.')); return; }
  store.name = name;
  const mine = myStores.find((s) => s.id === store.id);
  if (mine) mine.name = name;
  showStore();
  toast('Store renamed');
});

// Suggest a short name from the store name.
$('newStoreName').addEventListener('input', () => {
  if ($('newStoreSlug').dataset.touched) return;
  $('newStoreSlug').value = $('newStoreName').value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
});
$('newStoreSlug').addEventListener('input', () => { $('newStoreSlug').dataset.touched = '1'; });

$('storeCreateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('newStoreError', '');
  const name = $('newStoreName').value.trim();
  const slug = $('newStoreSlug').value.trim().toLowerCase();
  if (!name) { showError('newStoreError', 'Give the store a name.'); return; }
  if (!/^[a-z0-9][a-z0-9-]{1,29}$/.test(slug)) { showError('newStoreError', 'The short name must be 2 to 30 lower-case letters, numbers or dashes.'); return; }
  $('newStoreSave').disabled = true;
  const { data, error } = await sb.rpc('create_store', { p_name: name, p_slug: slug });
  $('newStoreSave').disabled = false;
  if (error) { showError('newStoreError', explain(error, 'Could not create the store.')); return; }
  $('storeCreateForm').reset();
  delete $('newStoreSlug').dataset.touched;
  myStores = await loadMyStores(userId);
  toast(`${data.name} created`);
  currentTab = 'products'; // show the new, empty store
  switchStore(data.slug);
  window.scrollTo(0, 0);
});

/** Fills in the store name, the switcher and the links for the current store. */
function showStore() {
  $('storeTitle').textContent = store.name;
  document.title = `${store.name} · Back office`;
  for (const node of document.querySelectorAll('.store-name-here')) node.textContent = store.name;
  const select = $('storeSwitch');
  select.replaceChildren(...myStores.map((s) => { const o = el('option', '', s.name); o.value = s.slug; o.selected = s.id === store.id; return o; }));
  select.hidden = myStores.length < 2;
  $('storeTitle').hidden = myStores.length >= 2;
  $('inventoryLink').href = `./?store=${encodeURIComponent(store.slug)}`;
  $('whoRole').textContent = `${ROLE_NAMES[role]} at ${store.name}`;
}

/** Opens one of my stores, leaving nothing from the previous one on screen. */
function switchStore(slug) {
  const next = myStores.find((s) => s.slug === slug) || myStores[0];
  if (!next) return;
  store = next;
  role = next.role;
  rememberStore(store.slug);
  showStoreInLink(store.slug);
  items = [];
  loaded = false;
  filter = 'all';
  $('search').value = '';
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  document.body.dataset.role = role;
  showStore();
  showTab(currentTab === 'users' && !isSuper() ? 'products' : currentTab);
  render();
  refreshQuietly();
}

$('storeSwitch').addEventListener('change', () => switchStore($('storeSwitch').value));

// ---------- My profile ----------

let myProfile = null; // { account_code, display_name }

async function loadMyProfile(id) {
  const { data } = await sb.from('profiles').select('account_code, display_name').eq('user_id', id).maybeSingle();
  if (userId !== id) return null;
  myProfile = data || null;
  myAccountId = showAccountId(myProfile && myProfile.account_code);
  return myProfile;
}

function showProfileTab() {
  $('profEmail').textContent = userEmail;
  $('profIdCopy').textContent = myAccountId || '—';
  $('profName').value = (myProfile && myProfile.display_name) || '';
  showError('profNameError', '');
  showError('profPasswordError', '');
  const list = $('profStores');
  list.replaceChildren(...myStores.map((s) => {
    const li = el('li', 'row-card');
    const main = el('div', 'row-main');
    main.append(el('div', 'row-title', s.name), el('div', 'hint', `${ROLE_NAMES[s.role]}${s.id === store.id ? ' · open now' : ''}`));
    li.append(main);
    if (s.id !== store.id) {
      const go = el('button', 'btn', 'Open');
      go.type = 'button';
      go.setAttribute('aria-label', `Open ${s.name}`);
      go.addEventListener('click', () => { currentTab = 'products'; switchStore(s.slug); window.scrollTo(0, 0); });
      const actions = el('div', 'row-actions');
      actions.append(go);
      li.append(actions);
    }
    return li;
  }));
}

$('profIdCopy').addEventListener('click', async () => {
  if (!myAccountId) return;
  try {
    await navigator.clipboard.writeText(myAccountId);
    toast('Account ID copied');
  } catch {
    toast(`Your account ID is ${myAccountId}`);
  }
});

$('profNameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('profName').value.trim();
  showError('profNameError', '');
  $('profNameSave').disabled = true;
  const { data, error } = await sb.from('profiles').update({ display_name: name }).eq('user_id', userId).select('display_name');
  $('profNameSave').disabled = false;
  if (error || !data.length) { showError('profNameError', explain(error, 'Could not save your name.')); return; }
  if (myProfile) myProfile.display_name = name;
  toast(name ? 'Name saved' : 'Name removed');
});

$('profPasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const current = $('profCurrent').value;
  const next = $('profNew').value;
  showError('profPasswordError', '');
  if (!current) { showError('profPasswordError', 'Enter your current password.'); $('profCurrent').focus(); return; }
  if (next.length < 8) { showError('profPasswordError', 'The new password needs at least 8 characters.'); $('profNew').focus(); return; }
  if (next !== $('profNew2').value) { showError('profPasswordError', 'The two new passwords are not the same.'); $('profNew2').focus(); return; }
  if (next === current) { showError('profPasswordError', 'The new password is the same as the current one.'); return; }
  $('profPasswordSave').disabled = true;
  try {
    // Signing in again checks the current password (and counts wrong ones).
    const check = await passwordSignIn(userEmail, current);
    if (!check.ok) {
      showError('profPasswordError', check.message || 'Your current password is not right.');
      return;
    }
    const { error } = await sb.auth.updateUser({ password: next });
    if (error) { showError('profPasswordError', explain(error, 'Could not change your password.')); return; }
    $('profPasswordForm').reset();
    toast('Password changed');
  } finally {
    $('profPasswordSave').disabled = false;
  }
});

// ---------- Sign in / out ----------

const signOut = () => sb.auth.signOut({ scope: 'local' });
$('signOutBtn').addEventListener('click', signOut);
$('noRoleSignOut').addEventListener('click', signOut);

let sessionApplied = false;
async function applySession(session) {
  const user = (session && session.user) || null;
  const id = user ? user.id : null;
  if (sessionApplied && id === userId) return; // e.g. a token refresh
  sessionApplied = true;
  userId = id;
  role = null;
  store = null;
  myStores = [];
  setStatus('');
  // Leave nothing about products, prices or profit on screen between accounts.
  items = [];
  loaded = false;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  delete document.body.dataset.role;
  if (!id) {
    document.body.dataset.view = 'login';
    render();
    return;
  }

  let stores = [];
  try {
    stores = await loadMyStores(id);
  } catch (error) {
    if (userId !== id) return;
    document.body.dataset.view = 'app';
    render();
    setStatus(explain(error, 'Could not check your access. Reload the page to try again.'));
    return;
  }
  if (userId !== id) return; // changed while we were asking
  if (!stores.length) {
    $('noRoleEmail').textContent = user.email || '';
    $('noRoleIdLine').hidden = true;
    document.body.dataset.view = 'norole';
    // So they can be added to a store, show the account ID if they have one.
    loadMyProfile(id).then((p) => { if (p && p.account_code) { $('noRoleId').textContent = showAccountId(p.account_code); $('noRoleIdLine').hidden = false; } });
    return;
  }
  myStores = stores;
  store = chooseStore(stores);
  if (location.hash === '#profile') currentTab = 'profile';
  role = store.role;
  rememberStore(store.slug);
  showStoreInLink(store.slug);
  document.body.dataset.role = role;
  document.body.dataset.view = 'app';
  userEmail = user.email || '';
  $('whoEmail').textContent = userEmail;
  showStore();
  await loadMyProfile(id);
  $('cCode').value = randomCode();
  showTab(currentTab === 'profile' ? 'profile' : 'products');
  render();
  refreshQuietly();
}

// Supabase must not be called from inside this callback, hence the timeout.
sb.auth.onAuthStateChange((event, session) => setTimeout(() => applySession(session), 0));

loadPhotoCache().then(() => { if (photos.size) render(); });
