# Tally

A budget tracker built to be faster than a spreadsheet. Type "12.50 lunch" and it's logged.
It installs like an app on iPhone, Mac and Windows, works offline, and syncs between devices when you sign in.

## Install it
Open the app's web address, then:
- **iPhone:** Safari › Share › Add to Home Screen
- **Mac:** Safari › File › Add to Dock (or Chrome › Install)
- **Windows:** Edge or Chrome › "Install app" icon in the address bar

## How it's built
- `src/app.html` – the whole app UI and logic (plain HTML/CSS/JS, no build tools needed)
- `src/sync.js` – sign-in and sync with Supabase. Changes save on the device first and sync when online.
- `config.js` – your Supabase project URL and anon key. Leave them empty to run without login.
- `supabase/schema.sql` – database tables and security rules. Run it once in the Supabase SQL editor.
- `sw.js`, `manifest.webmanifest`, `icons/` – make it installable and offline-capable
- `python3 build.py` regenerates `index.html` (the installable app) and `preview.html` (a single-file preview without login)

## Supabase setup
1. Create a free project at supabase.com.
2. SQL Editor › New query › paste `supabase/schema.sql` › Run.
3. Authentication › URL Configuration › set **Site URL** to `https://ishaan12389012.github.io/Tally/`.
4. Project Settings › API › copy the Project URL and the anon (publishable) key into `config.js`.
