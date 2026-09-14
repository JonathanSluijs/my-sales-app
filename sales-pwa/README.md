# Sales Log PWA — GitHub Pages + Cloud Sync

This version works on iPhone, Android, tablets and desktop browsers. It can be installed as a PWA and uses **Supabase** for login, cloud storage and live synchronization between phones.

## What is included
- 5 editable products
- Unit prices
- Fixed bundle deal, e.g. 3 for €50
- Buy X, get Y free deals
- Record sales in a few taps
- Sales history and delete
- Today / all-time revenue stats
- Product-by-product totals
- CSV export
- JSON backup/import
- Email/password accounts
- Cloud sync across phones
- Live updates while multiple phones are open
- Offline/local fallback

## Part 1 — Create the cloud backend
1. Go to https://supabase.com and create a free project.
2. In the project, open **SQL Editor**.
3. Open `supabase.sql` from this folder, copy everything, and run it once.
4. Open **Project Settings -> API**.
5. Copy the **Project URL** and **anon/public key**.
6. Open `config.js` and paste them here:

```js
window.SALES_APP_CONFIG = {
  supabaseUrl: "https://YOURPROJECT.supabase.co",
  supabaseAnonKey: "YOUR_ANON_KEY"
};
```

The anon key is safe to expose in a browser app. The SQL file enables Row Level Security so a signed-in account can only access its own data.

### Optional: easier account creation
In Supabase open **Authentication -> Providers -> Email**. If you disable email confirmation, newly-created accounts can sign in immediately. If you keep confirmation enabled, users must click the confirmation email first.

## Part 2 — Put it on GitHub Pages
1. Create a GitHub repository, for example `sales-log`.
2. Upload every file in this folder to the repository root.
3. Open **Settings -> Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Select **main** and **/(root)**, then Save.
6. Open the GitHub Pages URL once deployment completes.

## Part 3 — Use it on phones
1. Open the GitHub Pages URL.
2. Create one account.
3. Sign into that same account on any phone that should share the sales database.
4. On iPhone: Safari -> Share -> **Add to Home Screen**.
5. On Android: Chrome -> menu -> **Install app** / **Add to Home Screen**.

## Putting in your real 5 products
Open **Settings -> Products & deals** in the app. Enter the names, normal prices and any deal for each of the five products, then tap **Save settings**. The configuration will sync to every signed-in phone.

## Important security note
Never put the Supabase `service_role` key in `config.js`. Only use the anon/public key.
