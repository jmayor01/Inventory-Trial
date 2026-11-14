# Inventory

A simple inventory app for phones. Add items with a description, price and
quantity, and use the phone's camera to scan barcodes. The inventory is shared
online, with roles deciding who can see and change what. It is a web app, so the same code runs on
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

## Who can do what

| Visitor | Can do |
| --- | --- |
| Anyone with the link | Look up one product by scanning or typing its exact barcode, and see its details |
| With a view-only passcode | Also view and search the whole list of items (read-only) |
| With a cashier passcode | Also sell: add items to a cart, optionally set a custom price for that sale, and confirm it, which takes the items out of stock |
| **Admin** (signed in) | Add, change and delete items, change stock, generate barcodes, import and export CSV, original prices and profit, passcodes |
| **Super admin** (signed in) | Everything an admin can, plus user accounts |

These rules are enforced by the database (`supabase/setup.sql`), not only by
the app, so they hold even for someone who talks to the database directly.

## Back office

Open **Menu → Staff sign in**, or go to `/admin.html`.

- **Products** — add, edit and delete. **No barcode? Generate one** makes up a
  valid EAN-13 starting with 2 (the range reserved for a shop's own codes).
- **Profit** — each product has an **original price** (what it
  cost you) and a **market price** (what it sells for). The page shows expected
  profit, margin, and the stock valued at both prices. *Expected profit* is what
  you earn if all current stock sells at its market price; sales are not recorded.
- **Sales** — what cashiers actually sold: profit, sales total, number of sales
  and items for today, the last 7 or 30 days, or all time, with every sale
  listed. A sale can be edited (quantities and prices) or cancelled; stock
  follows the change, and either one asks for your password first.
- **Users** (super admin) — create admin or super admin accounts, change a
  role, remove an account.
- **Passcodes** — create and delete the codes for people without an account:
  *view only*, or *cashier*, which can also record sales. Give each cashier
  their own so their sales can be told apart.
- **Export CSV** — with original price and profit columns.

Once signed in, the inventory app itself also unlocks adding, editing, stock
+/− and CSV import/export.

## Where the data lives

Items, photos, original prices, roles and passcodes are stored in a
[Supabase](https://supabase.com) database (the project is set in `config.js`).
A signed-in or passcode-holding device keeps a copy of the list for offline
viewing; it is removed on sign-out or when the passcode is forgotten.

## Set up Supabase (once)

1. **Database.** In the Supabase dashboard open **SQL Editor**, paste the whole
   of [`supabase/setup.sql`](supabase/setup.sql) and press **Run**. It is safe
   to run again and must be re-run whenever that file changes. If the project
   has exactly one account and nobody has a role yet, that account becomes the
   super admin; the end of the file shows how to pick one by hand.
2. **Sign-ups off.** **Authentication → Sign In / Providers → Allow new users
   to sign up → off**, so accounts can only be created by a super admin.
3. **User management function.** Deploy
   [`supabase/functions/manage-users`](supabase/functions/manage-users/index.ts)
   as an Edge Function named `manage-users` with **Verify JWT** switched off
   (it checks the caller itself). The **Users** screen needs it to create and
   remove accounts; everything else works without it.

To use a different Supabase project, change the two values in `config.js` (the
*publishable* key only — never a secret key) and repeat the steps above.

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
| `supabase/functions/manage-users` | Server function that creates and removes accounts |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and home-screen install |
| `vendor/` | Barcode reader ([barcode-detector](https://github.com/Sec-ant/barcode-detector) + ZXing WebAssembly) and the Supabase client, all MIT |
