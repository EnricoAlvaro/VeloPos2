# Integrated Reservation, Sales, and Inventory Management System

This project includes reservations, POS sales, general inventory, and a vegetable inventory module with batch tracking.

## Vegetable inventory features
- Vegetable catalog with kg, g, piece, and bunch base units.
- Separate delivery batches with supplier, quantity, cost, received date, and expiry date.
- FEFO usage: stock is deducted from the earliest-expiring usable batch first.
- Partial usage: only the quantity used is deducted; the remaining quantity stays in the batch.
- Cut/opened batch tracking with a shortened expiry date for the remaining portion.
- Waste records for spoilage/rot, peeling, trimming, discarded portions, and other waste.
- Alerts for low stock, expiry within two days, and expired batches.

## Deploy to Vercel
1. Create a managed MySQL database accessible from Vercel. Local XAMPP/MySQL on your computer is not accessible to a deployed Vercel app.
2. Import `database/database.sql` into the managed database.
3. Push this project folder to GitHub and import the repository in Vercel.
4. Add these Vercel environment variables: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_SSL`, `JWT_SECRET`, and `NODE_ENV=production`.
5. Deploy. Vercel uses `api/index.js` for the API and serves the static files in `public`.

## Local development
1. Copy `.env.example` to `.env` and set your local MySQL credentials and a long random `JWT_SECRET`.
2. Import `database/database.sql` into MySQL.
3. Run `npm install`, then `npm start`.
4. Open `http://localhost:3000`.

## Important notes
- The first registered account becomes Owner; later accounts become Staff.
- All vegetable quantities are entered in the vegetable's configured base unit. For example, if Carrots use kg, enter `0.500` to represent half a kilogram. Convert supplier packaging to the base unit before recording a delivery.
- FEFO usage and waste are allocated across batches in expiry-date order.
- If you enter a shortened expiry date during partial usage, the remaining quantity from the partially used batch is marked as cut/opened.
- Do not commit `.env` or expose database credentials in frontend files.
- Test the project against your own managed database before using it for real business records.
