# Inventory

A simple inventory app for phones. Add items with a description, price and
quantity, and use the phone's camera to scan barcodes. Everyone who opens the
app sees the same shared inventory; there is no login. It is a web app, so the same code runs on
Android and iOS with nothing to install from an app store.

## What it does

- **Scan barcode** — opens the camera. A known barcode shows that item's
  details; a new one starts a new item with the barcode filled in. The barcode
  can also be typed in, and phones that allow it get a **Light** button.
- **Add / edit / delete** items: name, barcode, price, quantity, description
  and an optional photo taken with the camera or picked from the gallery.
- **Item details** — tap an item to see its photo and every field, then
  **Edit** from there.
- **+ / −** buttons to adjust stock straight from the list or the details.
- **Totals and stock filters** — number of items, units and stock value at the
  top; **Low stock** (5 units or fewer) and **Out of stock** filters and badges.
- **Search** by name, description or barcode (typed or scanned). When the
  search matches a single item, its full details and large photo are shown.
- **Shared** — items and photos are stored online; a change made on one phone
  shows up on the others.
- **Backup** — export everything to CSV (opens in Excel / Google Sheets) and
  import it again. Photos are not part of the CSV.
- Can be added to the home screen like an app. Without a connection it shows
  the last copy it loaded; adding and changing items needs to be online.
- Light and dark mode follow the phone's setting.

Supported codes: EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39, Code 93, ITF,
Codabar, QR and Data Matrix.

## Back office

Open **Menu → Back office**, or go to `/admin.html`. It needs a login.

- **Add, edit and delete products**, with an **original price** (what it cost
  you) and a **market price** (what it sells for). The form shows the profit
  per unit while you type.
- **Profit at a glance** — expected profit, overall margin, and the stock valued
  at market price and at original price. *Expected profit* is what you earn if
  all current stock sells at its market price; the app does not record sales.
- Per product: original price, market price, profit per unit, margin, stock and expected profit,
  with sorting, search, and filters for products with no original price or
  selling at a loss.
- **Export CSV** including original price and profit.

Original prices are stored in their own table that only signed-in users can read,
so they never appear in the inventory app. Back-office users are the accounts
under **Authentication → Users** in Supabase; keep **Allow new users to sign
up** switched off there so nobody can create an account for themselves.

## Where the data lives

Items and photos are stored in a [Supabase](https://supabase.com) database
(the project is set in `config.js`). Each device also keeps a copy of the list
for offline viewing.

**The inventory app has no login.** Anyone who has the app link can view, change
and delete every item and photo (but not original prices or profit), and there is no record of who did what. Share the link
only with people you trust, and use **Backup → Export CSV** regularly so the
list can be restored if something is deleted.

## Set up Supabase (once)

In the Supabase dashboard open **SQL Editor**, paste the whole of
[`supabase/setup.sql`](supabase/setup.sql) and press **Run**. It creates the
tables and the rules that let the app use them. It is safe to run again, and
it must be re-run whenever that file changes.

To use a different Supabase project, change the two values in `config.js` (the
*publishable* key only — never a secret key) and run the script there.

Items that were saved on a phone before the inventory became shared are not
lost: the app offers to upload them the first time it opens, and the same
option stays available under **Backup**.

## Deploy

There is no build step: the repository is the website. The camera requires
**https**, which every option below provides.

**GitHub Pages**

1. Merge this code into the `main` branch.
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a
   branch**, pick `main` and `/ (root)`, and save.
3. After a minute the app is live at `https://<user>.github.io/<repository>/`.

**Netlify / Cloudflare Pages / Vercel** — create a site from this repository
with no build command and the repository root as the output folder.

## Install on a phone

The app shows an **Install** banner by itself. In Chrome, Edge and Samsung
Internet the button installs it directly; in Safari and Firefox it shows the
steps, because those browsers do not let a page start the installation.

By hand:

- **Android (Chrome):** open the link → menu **⋮** → **Add to Home screen**.
- **iPhone / iPad (Safari):** open the link → **Share** → **Add to Home Screen**.

Allow camera access the first time you tap **Scan barcode**.

## Run locally

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. The camera works on `localhost`, but opening
it from a phone over plain `http://<ip>` will not — use a deployed https link.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `app.js` | The inventory app |
| `admin.html`, `admin.js` | The back office |
| `common.js`, `styles.css` | Code and styles both pages share |
| `config.js` | Which Supabase project to use |
| `supabase/setup.sql` | Database tables and access rules |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and home-screen install |
| `vendor/` | Barcode reader ([barcode-detector](https://github.com/Sec-ant/barcode-detector) + ZXing WebAssembly) and the Supabase client, all MIT |
