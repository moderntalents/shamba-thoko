# Shamba Soko – Farm Marketplace

Buy and sell farm produce, seedlings and farm inputs in Kenya. English and Kiswahili.

## What works

- **Accounts**: sign up and log in with a phone number and password, as a buyer or a seller. Buyers can switch to a seller account. Users can delete their account.
- **Selling**: sellers list goods with price, unit, county, up to 6 photos (resized, location data removed) and an optional video (up to 20 MB). Agrochemicals need a PCPB confirmation and show a warning.
- **Shop**: search, filter by county and category, photo gallery, video, contact the seller by phone or WhatsApp (signed-in users only).
- **Orders**: the cart becomes one order per seller. Prices are taken from the database, not the phone. Sellers confirm (with the final total and delivery details), dispatch or decline. Buyers cancel or confirm receipt. Both can report a problem. Sellers see new orders straight away.
- **Payments** are not processed: buyer and seller agree payment directly (for example M-Pesa).
- **Reports and admin**: users report listings, photos and orders. Admins see reports, hide or unhide listings, remove photos, see all accounts and orders, and change order status.
- **Prices and crop doctor**: guide prices and basic crop advice.

## Tech

- Vite + plain JavaScript (`src/`)
- Supabase: Auth, Postgres with row-level security, Storage (`listing-media` bucket), Realtime
- Database setup: `supabase/migrations/20261121120000_init.sql`

All important rules (who can list, order, change an order, see phone numbers, act as admin) are enforced in the database, not only in the app.

## Run locally

```bash
npm install
npm run dev
```

The app connects to the Supabase project `nskbksmguplcdchbbxje` by default. To use another project, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (see `.env.example`). The publishable key is public by design.

## Deploy

Any static host works (for example Vercel): build command `npm run build`, output folder `dist`.

## Admins

Admins are added by the project owner only, in the Supabase SQL editor, after the person has created an account:

```sql
insert into public.admins (user_id)
select id from public.profiles where phone = '2547XXXXXXXX';
```

## Notes before wide launch

- Phone numbers are not verified by SMS yet. Adding an SMS provider (for example Africa's Talking or Twilio) would allow phone verification and self-service password reset.
- The terms and privacy text in "Help & legal" are drafts.
