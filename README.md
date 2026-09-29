# TOHA'S MART

TOHA'S MART is a vanilla HTML/CSS/JavaScript storefront with an Express API and a SQLite database. The existing product catalog and visual design remain in place; customer data, carts, wishlists, orders, and inventory are stored server-side.

## Requirements

- Node.js 24 or later
- npm

## Install and run

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` and set a long random `SESSION_SECRET`, a private `ADMIN_EMAIL`, and an `ADMIN_PASSWORD` of at least 10 characters. Generate a session secret with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

Start the application:

```powershell
npm start
```

For development with Node's file watcher:

```powershell
npm run dev
```

Open `http://localhost:3000/` (or `http://localhost:3000/index.html`). Do not use Live Server or open the HTML files directly; API-backed features require the Node server.

## Accounts

- Customers can register at `/register.html`, then sign in at `/login.html`.
- The first administrator is created from `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` when the server starts. The password is stored as a scrypt hash, not plaintext.
- Open `/admin.html`; unauthenticated visitors are redirected to the login page. Admin API routes verify the administrator record on the server.
- Sessions use an HTTP-only, same-site cookie and are stored in SQLite. Production requires an explicit `SESSION_SECRET` and uses secure cookies.

## Store features

Customers can browse database-backed products, search, create a wishlist, manage a cart, save addresses, and place cash-on-delivery orders. The server calculates prices and delivery totals from the database, checks stock in a transaction, decrements tracked stock, clears the cart, and prevents duplicate order submission with an idempotency key. Customers can see their order history and status; only delivered purchases can be reviewed, and reviews require admin approval.

Administrators can manage products and categories, upload/replace product images from the product form, adjust inventory, update order status, moderate reviews, view customer summaries, and see sales reports. Uploaded images are validated and saved automatically by the server; there is no manual copying step. Existing project images continue to use their existing paths.

Sales and average order value report delivered orders only. Online payments, password recovery, full customer export, and multi-image product galleries are not implemented; checkout currently supports cash on delivery.

## Data locations

- SQLite: `.data/catalog.sqlite` by default. Set `DATABASE_PATH` in `.env` to use another persistent path.
- Product images: `images/`. Newly selected files are uploaded automatically and assigned a safe generated filename.
- `.env` is local configuration and must not be committed. `.data/`, `node_modules/`, and uploaded files are ignored by Git.

On first startup, the server creates missing tables and seeds the existing `products.js` catalog only if the database has no products. Existing database rows are not overwritten by startup. Categories and inventory/image metadata are initialized without duplicating products.

## Backup and restore

The admin Settings page can export/import product JSON and restore the original product catalog. Import and reset replace the current product catalog; review the confirmation before proceeding.

For a complete backup including accounts, orders, inventory, and settings, stop the server and copy `.data/catalog.sqlite` together with the `images/` directory to a secure backup location. Restore both to the same paths while the server is stopped. Product JSON exports do not contain customer credentials or replace a full database backup.

## Security note

This is a local starter application. Before exposing it to the public internet, deploy behind HTTPS, set production secrets, use persistent storage for the database and images, and add operational protections such as scheduled backups and monitoring. Never publish your `.env` file or share the seeded administrator password.
