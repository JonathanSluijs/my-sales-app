# V3 inventory update

This version adds the dedicated Large product workflow.

## Large product rules
- Standard sale: 0.7 stock for €50
- Full sale: 1.0 stock for €60
- 3 + 1 deal: customer receives four 0.7 portions, pays €150, stock used = 2.8
- 2 + 1 deal: customer receives three 0.7 portions, pays €100, stock used = 2.1
- Current stock is stored as whole-product equivalent (for example 50.0)
- Deleting a sale restores the stock that sale used

## Upgrade your existing deployment
1. Replace `app.js`, `index.html`, `style.css`, `sw.js`, and `supabase.sql` in GitHub with the files from this package.
2. In Supabase -> SQL Editor, paste the NEW `supabase.sql` and run it once. It is safe to rerun on the existing database.
3. In the app, go to Settings and set the current Large product stock (for example 50).
4. Save settings.
5. Hard refresh the website once so the updated service worker is loaded.

Your existing sales table and login remain intact.
