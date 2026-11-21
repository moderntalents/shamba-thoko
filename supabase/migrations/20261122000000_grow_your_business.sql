-- "Grow your business": optional paid promotions for sellers.
--   Featured product (KSh 100 / 7 days), Sponsored advertisement (KSh 2,000 / 30 days), Promoted shop (KSh 500 / 30 days).
--   The Verified Seller blue tick (KSh 500) keeps its own identity process; only its payment is shown here and counted in revenue.
-- Flow: seller requests -> admin reviews and approves -> seller pays (M-Pesa Paybill, account = payer's full name)
--       -> seller submits the transaction code -> admin confirms payment -> the promotion starts.
-- Nothing is ever active before admin approval AND payment confirmation. Registration and listings stay free.

-- ---------------------------------------------------------------- catalogue (prices editable by admins)
create table public.promo_services (
  key text primary key check (key in ('featured', 'sponsored', 'promoted_shop')),
  name text not null,
  price integer not null check (price between 1 and 1000000),
  days integer not null check (days between 1 and 365),
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.promo_services enable row level security;
create policy "promotion prices are public" on public.promo_services for select to anon, authenticated using (true);
insert into public.promo_services (key, name, price, days) values
  ('featured', 'Featured product', 100, 7),
  ('sponsored', 'Sponsored advertisement', 2000, 30),
  ('promoted_shop', 'Promoted shop', 500, 30)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- requests
create table public.promo_requests (
  id bigint generated always as identity primary key,
  seller uuid references public.profiles (id) on delete set null,   -- kept for revenue records after account deletion
  service text not null references public.promo_services (key),
  listing_id bigint references public.listings (id) on delete set null,
  seller_name text not null,
  title text not null default '' check (char_length(title) <= 60 and title !~ '[✓✔☑✅🗸√]'),
  body text not null default '' check (char_length(body) <= 200),
  price integer not null,
  days integer not null,
  status text not null default 'submitted'
    check (status in ('submitted', 'approved', 'payment_submitted', 'active', 'expired', 'rejected', 'cancelled', 'ended')),
  payer_name text,
  mpesa_code text check (mpesa_code is null or mpesa_code ~ '^[A-Z0-9]{8,12}$'),
  admin_note text not null default '',
  approved_at timestamptz,
  payment_confirmed_at timestamptz,
  starts_at timestamptz,
  ends_at timestamptz,
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index promo_requests_mpesa_code_key on public.promo_requests (mpesa_code) where mpesa_code is not null;
create index promo_requests_seller_idx on public.promo_requests (seller, created_at desc);
create index promo_requests_status_idx on public.promo_requests (status, created_at desc);
alter table public.promo_requests enable row level security;
create policy "sellers read own requests, admins read all" on public.promo_requests for select to authenticated
  using (seller = (select auth.uid()) or (select public.is_admin()));
revoke all on public.promo_services, public.promo_requests from anon, authenticated;
grant select on public.promo_services to anon, authenticated;
grant select on public.promo_requests to authenticated;

-- One M-Pesa code can pay for only one thing (verification or promotion).
create or replace function public.mpesa_code_used(p_code text, p_promo bigint default null, p_verif bigint default null) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.promo_requests where mpesa_code = p_code and id is distinct from p_promo)
      or exists (select 1 from public.seller_verifications where mpesa_code = p_code and id is distinct from p_verif);
$$;
revoke all on function public.mpesa_code_used(text, bigint, bigint) from public, anon, authenticated;
-- Verification payments (existing process, unchanged) also refuse codes already used for a promotion.
create or replace function public.verif_code_not_used_for_promo() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.mpesa_code is not null and exists (select 1 from public.promo_requests where mpesa_code = new.mpesa_code) then
    raise exception 'this M-Pesa code was already used' using errcode = '22023';
  end if;
  return new;
end;
$$;
drop trigger if exists verif_code_not_used_for_promo on public.seller_verifications;
create trigger verif_code_not_used_for_promo before insert or update of mpesa_code on public.seller_verifications
  for each row execute function public.verif_code_not_used_for_promo();

-- Notifications can now also refer to a promotion request.
alter table public.seller_notifications add column if not exists promo_request_id bigint references public.promo_requests (id) on delete set null;
create unique index if not exists seller_notifications_promo_kind on public.seller_notifications (promo_request_id, kind) where promo_request_id is not null;

create or replace function public.promo_log(p_status text, p_by text, p_note text default '') returns jsonb
language sql stable as $$
  select jsonb_build_array(jsonb_build_object('s', p_status, 'by', p_by, 'at', public.ms_now(), 'note', left(coalesce(p_note, ''), 300), 'actor', (select auth.uid())));
$$;
create or replace function public.promo_notify(p_req bigint, p_kind text) returns void
language sql security definer set search_path = '' as $$
  insert into public.seller_notifications (seller, promo_request_id, kind)
  select seller, id, p_kind from public.promo_requests where id = p_req and seller is not null
  on conflict do nothing;
$$;
revoke all on function public.promo_log(text, text, text), public.promo_notify(bigint, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- seller actions
-- Basic content and account checks only (no identity verification needed).
create or replace function public.promo_request(p_service text, p_listing bigint default null, p_title text default '', p_body text default '')
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid()); me public.profiles; svc public.promo_services; l public.listings;
  v_title text := regexp_replace(btrim(coalesce(p_title, '')), '\s+', ' ', 'g');
  v_body text := regexp_replace(btrim(coalesce(p_body, '')), '\s+', ' ', 'g');
  v_id bigint; n int;
begin
  select * into me from public.profiles where id = uid;
  if me.id is null or me.role <> 'seller' then raise exception 'seller account required' using errcode = '42501'; end if;
  if exists (select 1 from public.verification_blocks b where b.seller = uid and b.lifted_at is null and b.redacted_at is null) then
    raise exception 'your account cannot buy promotions: contact support' using errcode = '42501';
  end if;
  select * into svc from public.promo_services where key = p_service;
  if svc.key is null or not svc.active then raise exception 'this service is not available' using errcode = '22023'; end if;
  select count(*) into n from public.promo_requests where seller = uid and created_at > now() - interval '1 day';
  if n >= 10 then raise exception 'too many requests today' using errcode = 'P0001'; end if;
  if v_title ~ '[✓✔☑✅🗸√]' or v_body ~ '[✓✔☑✅🗸√]' then raise exception 'text cannot contain check-mark symbols' using errcode = '22023'; end if;
  if v_body ~* '(https?://|www\.)' then raise exception 'links are not allowed in the text' using errcode = '22023'; end if;

  if p_service in ('featured', 'sponsored') and p_listing is not null or p_service = 'featured' then
    select * into l from public.listings where id = p_listing and owner = uid and not hidden;
    if l.id is null then raise exception 'choose one of your visible listings' using errcode = '22023'; end if;
  end if;
  if p_service = 'featured' then
    if exists (select 1 from public.promo_requests where listing_id = l.id and service = 'featured'
                and status in ('submitted', 'approved', 'payment_submitted', 'active')) then
      raise exception 'this listing already has a featured request or is already featured' using errcode = '22023';
    end if;
    v_title := l.name; v_body := '';
  elsif p_service = 'sponsored' then
    if char_length(v_title) not between 3 and 60 then raise exception 'add a headline (3 to 60 characters)' using errcode = '22023'; end if;
    if char_length(v_body) not between 10 and 200 then raise exception 'add the advert text (10 to 200 characters)' using errcode = '22023'; end if;
  elsif p_service = 'promoted_shop' then
    if not exists (select 1 from public.listings where owner = uid and not hidden) then
      raise exception 'add at least one listing before promoting your shop' using errcode = '22023';
    end if;
    if exists (select 1 from public.promo_requests where seller = uid and service = 'promoted_shop'
                and status in ('submitted', 'approved', 'payment_submitted', 'active')) then
      raise exception 'you already have a shop promotion request or an active promotion' using errcode = '22023';
    end if;
    if char_length(v_body) > 120 then raise exception 'shop tagline can be up to 120 characters' using errcode = '22023'; end if;
    v_title := coalesce(nullif(me.biz, ''), me.name);
  end if;
  if (select count(*) from public.promo_requests where seller = uid and status in ('submitted', 'approved', 'payment_submitted')) >= 10 then
    raise exception 'too many open requests' using errcode = 'P0001';
  end if;

  insert into public.promo_requests (seller, service, listing_id, seller_name, title, body, price, days, history)
  values (uid, svc.key, case when p_service = 'promoted_shop' then null else l.id end, coalesce(nullif(me.biz, ''), me.name),
          v_title, v_body, svc.price, svc.days, public.promo_log('submitted', 'seller', 'Request sent'))
  returning id into v_id;
  return v_id;
end;
$$;

-- After admin approval, the seller pays and submits the M-Pesa transaction code and the payer's full name.
create or replace function public.promo_submit_payment(p_id bigint, p_code text, p_payer text) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); r public.promo_requests;
  v_code text := upper(btrim(coalesce(p_code, ''))); v_payer text := regexp_replace(btrim(coalesce(p_payer, '')), '\s+', ' ', 'g');
begin
  select * into r from public.promo_requests where id = p_id for update;
  if r.id is null or r.seller is distinct from uid then raise exception 'request not found' using errcode = 'P0002'; end if;
  if r.status <> 'approved' then raise exception 'pay only after your request is approved' using errcode = '22023'; end if;
  if v_code !~ '^[A-Z0-9]{8,12}$' then raise exception 'invalid M-Pesa code' using errcode = '22023'; end if;
  if char_length(v_payer) not between 3 and 80 then raise exception 'enter the full name you paid with' using errcode = '22023'; end if;
  if public.mpesa_code_used(v_code, r.id, null) then raise exception 'this M-Pesa code was already used' using errcode = '22023'; end if;
  update public.promo_requests
     set mpesa_code = v_code, payer_name = v_payer, status = 'payment_submitted', updated_at = now(),
         history = history || public.promo_log('payment_submitted', 'seller', 'Code ' || v_code)
   where id = r.id;
end;
$$;

create or replace function public.promo_cancel(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); r public.promo_requests;
begin
  select * into r from public.promo_requests where id = p_id for update;
  if r.id is null or r.seller is distinct from uid then raise exception 'request not found' using errcode = 'P0002'; end if;
  if r.status not in ('submitted', 'approved') then raise exception 'this request can no longer be cancelled' using errcode = '22023'; end if;
  update public.promo_requests set status = 'cancelled', updated_at = now(), history = history || public.promo_log('cancelled', 'seller')
   where id = r.id;
end;
$$;

-- ---------------------------------------------------------------- admin actions
create or replace function public.admin_promo_action(p_id bigint, p_action text, p_note text default '', p_seen timestamptz default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare r public.promo_requests; v_note text := left(btrim(coalesce(p_note, '')), 300); v_label text;
begin
  perform public.require_admin();
  select * into r from public.promo_requests where id = p_id for update;
  if r.id is null then raise exception 'request not found' using errcode = 'P0002'; end if;
  if r.seller = (select auth.uid()) then raise exception 'admins cannot review their own request' using errcode = '42501'; end if;
  if p_seen is null or date_trunc('milliseconds', r.updated_at) <> date_trunc('milliseconds', p_seen) then
    raise exception 'this request changed: reload and check it again' using errcode = 'P0001';
  end if;

  if p_action = 'approve' and r.status = 'submitted' then
    update public.promo_requests set status = 'approved', approved_at = now(), admin_note = v_note where id = r.id;
    v_label := 'approved'; perform public.promo_notify(r.id, 'promo_approved');
  elsif p_action = 'reject' and r.status in ('submitted', 'approved') then
    if v_note = '' then raise exception 'add a reason for the seller' using errcode = '22023'; end if;
    update public.promo_requests set status = 'rejected', admin_note = v_note where id = r.id;
    v_label := 'rejected'; perform public.promo_notify(r.id, 'promo_rejected');
  elsif p_action = 'confirm_payment' and r.status = 'payment_submitted' then
    -- Payment confirmed after approval: the promotion starts now.
    if r.approved_at is null then raise exception 'approve the request first' using errcode = '22023'; end if;
    update public.promo_requests set status = 'active', payment_confirmed_at = now(), starts_at = now(),
           ends_at = now() + make_interval(days => r.days), admin_note = v_note where id = r.id;
    v_label := 'active'; perform public.promo_notify(r.id, 'promo_active');
  elsif p_action = 'reject_payment' and r.status = 'payment_submitted' then
    if v_note = '' then raise exception 'say why the payment was not confirmed' using errcode = '22023'; end if;
    update public.promo_requests set status = 'approved', mpesa_code = null, payer_name = null, admin_note = v_note where id = r.id;
    v_label := 'payment_rejected'; perform public.promo_notify(r.id, 'promo_payment_rejected');
  elsif p_action = 'end' and r.status = 'active' then
    if v_note = '' then raise exception 'add a reason' using errcode = '22023'; end if;
    update public.promo_requests set status = 'ended', ends_at = now(), admin_note = v_note where id = r.id;
    v_label := 'ended'; perform public.promo_notify(r.id, 'promo_ended');
  else
    raise exception 'this action is not possible now' using errcode = '22023';
  end if;
  update public.promo_requests set updated_at = now(), history = history || public.promo_log(v_label, 'admin', v_note) where id = r.id;
  perform public.verif_audit('promo_' || v_label, null, jsonb_build_object('request', r.id, 'service', r.service, 'note', v_note));
end;
$$;

create or replace function public.admin_set_promo_price(p_service text, p_price int, p_days int, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_old public.promo_services;
begin
  perform public.require_admin();
  select * into v_old from public.promo_services where key = p_service;
  if v_old.key is null then raise exception 'unknown service' using errcode = '22023'; end if;
  if p_price is null or p_price not between 1 and 1000000 then raise exception 'invalid price' using errcode = '22023'; end if;
  if p_days is null or p_days not between 1 and 365 then raise exception 'invalid number of days' using errcode = '22023'; end if;
  update public.promo_services set price = p_price, days = p_days, active = coalesce(p_active, true), updated_at = now() where key = p_service;
  perform public.verif_audit('promo_price_changed', null, jsonb_build_object('service', p_service,
    'before', jsonb_build_object('price', v_old.price, 'days', v_old.days, 'active', v_old.active),
    'after', jsonb_build_object('price', p_price, 'days', p_days, 'active', coalesce(p_active, true))));
end;
$$;

-- Revenue from confirmed payments only (promotions + Verified Seller fees). Admins only.
create or replace function public.admin_revenue() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare m timestamptz := date_trunc('month', now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi';
begin
  perform public.require_admin();
  return jsonb_build_object(
    'by_service', coalesce((select jsonb_object_agg(k, jsonb_build_object('count', c, 'total', t, 'month', mt)) from (
        select service k, count(*) c, sum(price) t, coalesce(sum(price) filter (where payment_confirmed_at >= m), 0) mt
          from public.promo_requests where payment_confirmed_at is not null group by service
        union all
        select 'verification', count(*), coalesce(sum(fee), 0), coalesce(sum(fee) filter (where payment_confirmed_at >= m), 0)
          from public.seller_verifications where payment_status = 'confirmed') x), '{}'::jsonb),
    'awaiting_confirmation', (select count(*) from public.promo_requests where status = 'payment_submitted')
      + (select count(*) from public.seller_verifications where payment_status = 'submitted' and status in ('pending', 'info_requested')),
    'active_promotions', (select count(*) from public.promo_requests where status = 'active' and ends_at > now()));
end;
$$;

-- Public: what is promoted right now. No payment data.
create or replace function public.active_promotions()
returns table (id bigint, service text, seller uuid, seller_name text, listing_id bigint, title text, body text, ends_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select r.id, r.service, r.seller, r.seller_name, r.listing_id, r.title, r.body, r.ends_at
    from public.promo_requests r
   where r.status = 'active' and r.payment_confirmed_at is not null and r.approved_at is not null
     and r.ends_at > now() and r.seller is not null
     and (r.listing_id is null or exists (select 1 from public.listings l where l.id = r.listing_id and not l.hidden));
$$;

-- Nightly: expire finished promotions; cancel approvals not paid within 14 days. Notifies the seller.
create or replace function public.promo_lifecycle_run() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; nexp int := 0; ncan int := 0;
begin
  perform public.verif_require_system_or_admin();
  for r in select id from public.promo_requests where status = 'active' and ends_at <= now() loop
    update public.promo_requests set status = 'expired', updated_at = now(),
      history = history || jsonb_build_array(jsonb_build_object('s', 'expired', 'by', 'system', 'at', public.ms_now())) where id = r.id;
    perform public.promo_notify(r.id, 'promo_expired'); nexp := nexp + 1;
  end loop;
  for r in select id from public.promo_requests where status = 'approved' and approved_at <= now() - interval '14 days' loop
    update public.promo_requests set status = 'cancelled', updated_at = now(), admin_note = 'Cancelled: not paid within 14 days of approval. You can send a new request.',
      history = history || jsonb_build_array(jsonb_build_object('s', 'cancelled', 'by', 'system', 'at', public.ms_now(), 'note', 'Not paid within 14 days')) where id = r.id;
    perform public.promo_notify(r.id, 'promo_unpaid_cancelled'); ncan := ncan + 1;
  end loop;
  return jsonb_build_object('expired', nexp, 'cancelled_unpaid', ncan);
end;
$$;

-- ---------------------------------------------------------------- grants
revoke all on function public.promo_request(text, bigint, text, text), public.promo_submit_payment(bigint, text, text),
  public.promo_cancel(bigint), public.admin_promo_action(bigint, text, text, timestamptz), public.admin_set_promo_price(text, int, int, boolean),
  public.admin_revenue(), public.promo_lifecycle_run() from public, anon;
grant execute on function public.promo_request(text, bigint, text, text), public.promo_submit_payment(bigint, text, text),
  public.promo_cancel(bigint), public.admin_promo_action(bigint, text, text, timestamptz), public.admin_set_promo_price(text, int, int, boolean),
  public.admin_revenue(), public.promo_lifecycle_run() to authenticated;
revoke all on function public.active_promotions() from public;
grant execute on function public.active_promotions() to anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.promo_lifecycle_run() to service_role;
  end if;
end $$;
