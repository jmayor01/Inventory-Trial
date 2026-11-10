# Inventory

A simple inventory app for phones. Add items with a description, price and
quantity, and use the phone's camera to scan barcodes. Everyone who signs in
sees the same shared inventory. It is a web app, so the same code runs on
Android and iOS with nothing to install from an app store.

## What it does

- **Scan barcode** — opens the camera. A known barcode opens that item; a new
  one starts a new item with the barcode filled in.
- **Add / edit / delete** items: barcode, name, description, price, quantity,
  and an optional photo taken with the camera or picked from the gallery.
- **+ / −** buttons to adjust stock straight from the list.
- **Search** by name, description or barcode; the header shows the total stock value.
- **Shared** — items and photos are stored online; a change made on one phone
  shows up on the others. Users sign in with an email and password.
- **Backup** — export everything to CSV (opens in Excel / Google Sheets) and
  import it again. Photos are not part of the CSV.
- Can be added to the home screen like an app. Without a connection it shows
  the last copy it loaded; adding and changing items needs to be online.

Supported codes: EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39, Code 93, ITF,
Codabar, QR and Data Matrix.

## Where the data lives

Items and photos are stored in a [Supabase](https://supabase.com) database
(the project is set in `config.js`). Only signed-in users can read or change
them; this is enforced by the database rules in `supabase/setup.sql`, not just
by the app. Each device keeps a copy of the list for offline viewing, which is
removed when the user signs out.

## Set up Supabase (once)

1. **Create the tables.** In the Supabase dashboard open **SQL Editor**, paste
   the whole of [`supabase/setup.sql`](supabase/setup.sql) and press **Run**.
2. **Turn off public sign-ups**, so that only people you add can get in:
   **Authentication → Sign In / Providers → Allow new users to sign up → off**.
   Without this step anyone who has the app link could create an account for
   themselves.
3. **Add your users.** **Authentication → Users → Add user → Create new user**:
   enter an email and password and keep **Auto Confirm User** ticked. Give each
   person their email and password. The app has no sign-up screen on purpose.

To use a different Supabase project, change the two values in `config.js` (the
*publishable* key only — never a secret key) and repeat the steps above.

Items that were saved on a phone before the inventory became shared are not
lost: after signing in on that phone the app offers to upload them, and the
same option stays available under **Menu**.

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
