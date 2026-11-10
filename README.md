# Inventory

A simple inventory app for phones. Add items with a description, price and
quantity, and use the phone's camera to scan barcodes. It is a web app, so the
same code runs on Android and iOS with nothing to install from an app store.

## What it does

- **Scan barcode** — opens the camera. A known barcode opens that item; a new
  one starts a new item with the barcode filled in.
- **Add / edit / delete** items: barcode, name, description, price, quantity,
  and an optional photo taken with the camera or picked from the gallery.
- **+ / −** buttons to adjust stock straight from the list.
- **Search** by name, description or barcode; the header shows the total stock value.
- **Backup** — export everything to CSV (opens in Excel / Google Sheets) and
  import it again, on this or another device. Photos are not part of the CSV.
- Works offline once opened, and can be added to the home screen like an app.

Supported codes: EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39, Code 93, ITF,
Codabar, QR and Data Matrix.

## Where the data lives

Items are stored **on the device, in the browser** — there is no server and no
account. That keeps it free and simple, but it means each phone has its own
list, and clearing the browser's site data deletes it. Use **Backup → Export
CSV** regularly. On iPhone, add the app to the home screen so iOS does not
clear data for sites that have not been visited for a while.

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
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and home-screen install |
| `vendor/` | Barcode reader ([barcode-detector](https://github.com/Sec-ant/barcode-detector) + ZXing WebAssembly, MIT) |
