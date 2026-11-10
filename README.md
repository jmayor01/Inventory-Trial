# Inventory

A simple inventory app for phones. Add items with a description, price and
quantity, and use the phone's camera to scan barcodes. Everyone who opens the
app sees the same shared inventory; there is no login. It is a web app, so the same code runs on
Android and iOS with nothing to install from an app store.

## What it does

- **Scan barcode** — opens the camera. A known barcode opens that item; a new
  one starts a new item with the barcode filled in.
- **Add / edit / delete** items: barcode, name, description, price, quantity,
  and an optional photo taken with the camera or picked from the gallery.
- **+ / −** buttons to adjust stock straight from the list.
- **Search** by name, description or barcode (typed or scanned). When the
  search matches a single item, its full details and large photo are shown.
- **Shared** — items and photos are stored online; a change made on one phone
  shows up on the others.
- **Backup** — export everything to CSV (opens in Excel / Google Sheets) and
  import it again. Photos are not part of the CSV.
- Can be added to the home screen like an app. Without a connection it shows
  the last copy it loaded; adding and changing items needs to be online.

Supported codes: EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39, Code 93, ITF,
Codabar, QR and Data Matrix.

## Where the data lives

Items and photos are stored in a [Supabase](https://supabase.com) database
(the project is set in `config.js`). Each device also keeps a copy of the list
for offline viewing.

**There is no login.** Anyone who has the app link can view, change and delete
every item and photo, and there is no record of who did what. Share the link
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
| `index.html`, `styles.css`, `app.js` | The whole app |
| `config.js` | Which Supabase project to use |
| `supabase/setup.sql` | Database tables and access rules |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and home-screen install |
| `vendor/` | Barcode reader ([barcode-detector](https://github.com/Sec-ant/barcode-detector) + ZXing WebAssembly) and the Supabase client, all MIT |
