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

## Verified Seller (optional blue tick)

- Sellers apply from **Account → Get verified**: legal name, phone, ID, business name and location, products, and four **live camera** photos (face front, face side, products, seller with products). Gallery uploads are not possible. Consent to collecting face photos is required.
- Fee: **KSh 500** by default. Admins can change the fee, validity (default 12 months) and payment instructions in the Admin dashboard.
- Payment: **M-Pesa Paybill 1315388**, account number = the seller's **full name** (admins can change both; changes are audited). The seller enters the M-Pesa transaction code after paying, or Shamba Soko confirms payment manually. Payment alone never gives the badge: an admin must check the transaction, **confirm payment and approve**.
- Admins review details and photos, confirm or reject payment, approve, reject, request more information, suspend, reinstate or revoke, and see the history and expiry date.
- The blue tick shows beside the seller on shop cards and search results, cart, orders, the contact dialog and the seller's profile. Tapping it explains what was checked.
- Photos are in the private `verification-photos` bucket (seller and admins only). The badge comes only from approved, paid, unexpired applications; sellers cannot set it themselves.
- Database: `supabase/migrations/20261121160000_seller_verification.sql` (additive).
- Automatic M-Pesa confirmation (STK push) needs Safaricom Daraja credentials; until then admins confirm payments by checking the M-Pesa code.

### Verification rules and data retention

- **Revoked** sellers can apply again only after **90 days** (checked by account and by ID number).
- Admins can **block** fraudulent sellers permanently (by account, phone and ID). Blocks survive account deletion; lifting a block needs a reason.
- **Photo inspection:** the approving admin must open all four photos full size after the seller's latest change; the database refuses approval otherwise.
- **Retention (automatic, nightly at 03:20 Nairobi time):**
  - not approved (rejected, withdrawn): ID number and photos deleted 90 days after closing;
  - approved: kept for the verification period plus 12 months after expiry;
  - fraud: kept up to 5 years after closing; block identifiers redacted after 5 years.
  - Never deleted automatically: open or suspended applications, and anything on **legal hold**.
- Purging redacts ID number, phone, legal name and location and deletes the photo files through the Storage API (Edge Function `verification-retention`, called by `pg_cron` with a secret kept in the database vault). Admins can also run it from the dashboard.
- Every action (submission, inspection, approval, block, hold, purge, file deletion) is written to an append-only, admin-only **audit trail**.
- **Unanswered requests:** applications in "More information needed" close automatically after **90 days** without a response (not under legal hold). The seller gets in-app reminders **30 and 7 days** before closure and a notice when it closes, and can then apply again (unless suspended, within the 90-day revocation wait, or blocked).
- **Consent wording** explains the retention periods, deletion requests, fraud investigations and legal holds. Notifications are in-app only; SMS or email needs a provider (for example Africa's Talking).

### WhatsApp contact (optional, verified sellers)

- Sellers can add a WhatsApp number (their phone number or a different one) in **Account → WhatsApp contact** or on the verification form, and choose whether to show it.
- A green **WhatsApp** button appears on listings, the contact window and the seller's profile only when the seller is **verified**, has **entered a number** and **chose to show it**. It disappears automatically if verification ends.
- The button uses the official click-to-chat link `https://wa.me/<number>?text=<message>`.
- Only the seller's id and WhatsApp number are public (`seller_whatsapp()`); no ID or verification data.
- Sellers without WhatsApp keep the normal phone contact.

## Grow your business (optional paid services)

Sellers open **Account → Grow your business**. Four optional services:

| Service | Default price | Duration | Checks |
|---|---|---|---|
| Featured product | KSh 100 | 7 days | the seller's own visible listing |
| Sponsored advert | KSh 2,000 | 30 days | headline and text, no links or phone numbers |
| Promoted shop | KSh 500 | 30 days | seller has at least one listing |
| Verified Seller blue tick | KSh 500 | 12 months | full identity verification (existing flow, unchanged) |

- **Flow:** seller sends a request → admin approves → seller pays by **M-Pesa Paybill 1315388**, account number = payer's full name → seller enters the transaction code → admin checks the statement and confirms → the service starts. Nothing is shown publicly before approval **and** payment confirmation (enforced in the database).
- Featured listings show first with a "⭐ Featured" label; sponsored adverts appear at the top of the shop marked "Sponsored"; promoted shops appear in a "Promoted shops" row. Promotions end automatically; approvals not paid within 14 days are cancelled. Sellers get in-app notifications at each step.
- **Admin dashboard → Grow your business:** requests by status, approve/reject, confirm or reject payments, end a promotion early, edit prices, durations and availability (changes apply to new requests only, audited), and revenue from confirmed payments (by service, this month and all time, including verification fees).
- Registration, listings and buying stay free. No commissions, no subscriptions: buyers and sellers deal directly.
- Database: `supabase/migrations/20261122000000_grow_your_business.sql`, schedule `20261122000100_grow_schedule.sql`.
