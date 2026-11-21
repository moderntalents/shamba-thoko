-- Optional "Verified Seller" blue tick. Additive only: no existing table, row or rule is changed.
--
-- * A seller applies with legal name, phone, national ID, business details, products and four live camera
--   photos (stored in a PRIVATE bucket), and consents to the collection of face photos.
-- * Payment (default KSh 500, admin can change it) is recorded by the seller (M-Pesa code) or confirmed manually
--   by an admin. Payment alone never verifies: an admin must confirm payment AND approve.
-- * The badge is derived from approved, paid, unexpired applications. No table holds a "verified" flag that a
--   seller could write, and sellers cannot change status, payment or expiry fields.
-- * Verification lasts 12 months by default (admin can change), then the seller renews with fresh details/photos.

create table public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
create policy "settings are public" on public.app_settings for select to anon, authenticated using (true);
insert into public.app_settings (key, value) values
  ('verification_fee', '500'),
  ('verification_months', '12'),
  ('verification_payment_info', '"Pay KSh 500 by M-Pesa. For the payment number, call or WhatsApp Shamba Soko support on 0747 859 353. Then enter your M-Pesa confirmation code below."')
on conflict (key) do nothing;

create table public.seller_verifications (
  id bigint generated always as identity primary key,
  seller uuid not null references public.profiles (id) on delete cascade,
  legal_name text not null check (char_length(legal_name) between 3 and 80),
  phone text not null check (phone ~ '^254[17][0-9]{8}$'),
  id_type text not null check (id_type in ('national_id', 'passport', 'alien_id')),
  id_number text not null check (id_number ~ '^[A-Za-z0-9]{5,12}$'),
  business_name text not null check (char_length(business_name) between 2 and 80),
  county text not null references public.counties (name),
  location text not null check (char_length(location) between 3 and 120),
  products text not null check (char_length(products) between 3 and 200),
  photos jsonb not null,            -- {face_front, face_side, products, with_products}: private storage paths
  consent_at timestamptz not null,
  fee integer not null,
  payment_method text check (payment_method in ('mpesa', 'manual')),
  mpesa_code text check (mpesa_code ~ '^[A-Z0-9]{8,12}$'),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'submitted', 'confirmed', 'rejected')),
  payment_confirmed_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending', 'info_requested', 'approved', 'rejected', 'suspended', 'revoked')),
  admin_note text not null default '',
  approved_at timestamptz,
  expires_at timestamptz,
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index seller_verifications_seller_idx on public.seller_verifications (seller, created_at desc);
create index seller_verifications_status_idx on public.seller_verifications (status, created_at desc);
alter table public.seller_verifications enable row level security;
create policy "sellers read own applications, admins read all" on public.seller_verifications for select to authenticated
  using (seller = (select auth.uid()) or (select public.is_admin()));
-- No insert/update/delete policies: all changes go through the functions below.

-- Private bucket for verification photos. Only the seller (own folder) and admins can read them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('verification-photos', 'verification-photos', false, 5242880, array['image/jpeg'])
on conflict (id) do nothing;
create policy "sellers upload verification photos to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'verification-photos' and (storage.foldername(name))[1] = (select auth.uid())::text
              and (select public.is_seller()));
create policy "sellers and admins read verification photos" on storage.objects for select to authenticated
  using (bucket_id = 'verification-photos' and ((storage.foldername(name))[1] = (select auth.uid())::text
         or (select public.is_admin())));
-- Sellers can delete their own photos (for example when deleting their account); admins can delete any.
create policy "sellers and admins delete verification photos" on storage.objects for delete to authenticated
  using (bucket_id = 'verification-photos' and ((storage.foldername(name))[1] = (select auth.uid())::text
         or (select public.is_admin())));

-- ---------------------------------------------------------------- public badge
-- Only seller ids and expiry dates are public; no documents or personal details.
create or replace function public.verified_sellers()
returns table (seller uuid, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select distinct on (v.seller) v.seller, v.expires_at
    from public.seller_verifications v
   where v.status = 'approved' and v.payment_status = 'confirmed' and v.expires_at > now()
   order by v.seller, v.expires_at desc;
$$;

-- ---------------------------------------------------------------- helpers
create or replace function public.verif_setting_int(p_key text, p_default int) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce((select (value #>> '{}')::int from public.app_settings where key = p_key), p_default);
$$;

-- Checks the four photo paths: own private folder, a real uploaded file, all different.
create or replace function public.verif_check_photos(p_photos jsonb, p_uid uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare k text; v text; seen text[] := '{}';
begin
  if jsonb_typeof(p_photos) <> 'object' then raise exception 'photos required' using errcode = '22023'; end if;
  foreach k in array array['face_front', 'face_side', 'products', 'with_products'] loop
    v := p_photos ->> k;
    if v is null or v !~ ('^' || p_uid::text || '/[a-z_]{5,14}-[0-9a-f]{24}\.jpg$') or v = any (seen)
       or not exists (select 1 from storage.objects where bucket_id = 'verification-photos' and name = v) then
      raise exception 'photo % missing or invalid', k using errcode = '22023';
    end if;
    seen := seen || v;
  end loop;
  return jsonb_build_object('face_front', p_photos ->> 'face_front', 'face_side', p_photos ->> 'face_side',
                            'products', p_photos ->> 'products', 'with_products', p_photos ->> 'with_products');
end;
$$;

create or replace function public.verif_log(p_status text, p_by text, p_note text default '') returns jsonb
language sql stable as $$
  select jsonb_build_array(jsonb_build_object('s', p_status, 'by', p_by, 'at', public.ms_now(), 'note', left(coalesce(p_note, ''), 300)));
$$;

-- ---------------------------------------------------------------- seller actions
create or replace function public.submit_verification(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  me public.profiles;
  cur public.seller_verifications;
  v_phone text := regexp_replace(coalesce(p ->> 'phone', ''), '[\s-]', '', 'g');
  v_code text := upper(btrim(coalesce(p ->> 'mpesa_code', '')));
  v_method text := nullif(p ->> 'payment_method', '');
  v_id bigint; n int;
begin
  select * into me from public.profiles where id = uid;
  if me.id is null or me.role <> 'seller' then raise exception 'seller account required' using errcode = '42501'; end if;
  if coalesce((p ->> 'consent')::boolean, false) is not true then raise exception 'consent required' using errcode = '22023'; end if;
  select count(*) into n from public.seller_verifications where seller = uid and created_at > now() - interval '1 day';
  if n >= 3 then raise exception 'too many applications today' using errcode = 'P0001'; end if;
  select * into cur from public.seller_verifications where seller = uid order by created_at desc limit 1;
  if cur.id is not null then
    if cur.status in ('pending', 'info_requested') then raise exception 'you already have an open application' using errcode = '22023'; end if;
    if cur.status = 'suspended' then raise exception 'verification suspended: contact support' using errcode = '42501'; end if;
    if cur.status = 'approved' and cur.expires_at > now() + interval '30 days' then
      raise exception 'renewal opens 30 days before expiry' using errcode = '22023';
    end if;
  end if;
  if v_phone ~ '^(\+?254|0)[17][0-9]{8}$' then v_phone := '254' || right(v_phone, 9);
  else raise exception 'invalid phone' using errcode = '22023'; end if;
  if v_method = 'mpesa' and v_code !~ '^[A-Z0-9]{8,12}$' then raise exception 'invalid M-Pesa code' using errcode = '22023'; end if;
  if v_method is not null and v_method not in ('mpesa', 'manual') then raise exception 'invalid payment method' using errcode = '22023'; end if;

  insert into public.seller_verifications
    (seller, legal_name, phone, id_type, id_number, business_name, county, location, products, photos, consent_at, fee,
     payment_method, mpesa_code, payment_status, history)
  values (uid, regexp_replace(btrim(p ->> 'legal_name'), '\s+', ' ', 'g'), v_phone, p ->> 'id_type', upper(btrim(p ->> 'id_number')),
          btrim(p ->> 'business_name'), p ->> 'county', btrim(p ->> 'location'), btrim(p ->> 'products'),
          public.verif_check_photos(p -> 'photos', uid), now(), public.verif_setting_int('verification_fee', 500),
          v_method, case when v_method = 'mpesa' then v_code end,
          case when v_method is null then 'unpaid' else 'submitted' end,
          public.verif_log('pending', 'seller', case when cur.id is null then 'Application submitted' else 'Renewal submitted' end))
  returning id into v_id;
  return v_id;
end;
$$;

-- The seller answers an information request or adds payment details. Status, payment confirmation and expiry stay with admins.
create or replace function public.update_verification(p_id bigint, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v public.seller_verifications;
  v_code text := upper(btrim(coalesce(p ->> 'mpesa_code', '')));
  v_method text := nullif(p ->> 'payment_method', '');
  v_phone text := regexp_replace(coalesce(p ->> 'phone', ''), '[\s-]', '', 'g');
begin
  select * into v from public.seller_verifications where id = p_id for update;
  if v.id is null or v.seller is distinct from uid then raise exception 'application not found' using errcode = 'P0002'; end if;
  if v.status not in ('pending', 'info_requested') then raise exception 'this application can no longer be changed' using errcode = '22023'; end if;

  if p ? 'legal_name' then
    if coalesce((p ->> 'consent')::boolean, false) is not true then raise exception 'consent required' using errcode = '22023'; end if;
    if v_phone ~ '^(\+?254|0)[17][0-9]{8}$' then v_phone := '254' || right(v_phone, 9);
    else raise exception 'invalid phone' using errcode = '22023'; end if;
    update public.seller_verifications set
      legal_name = regexp_replace(btrim(p ->> 'legal_name'), '\s+', ' ', 'g'), phone = v_phone,
      id_type = p ->> 'id_type', id_number = upper(btrim(p ->> 'id_number')),
      business_name = btrim(p ->> 'business_name'), county = p ->> 'county', location = btrim(p ->> 'location'),
      products = btrim(p ->> 'products'), photos = public.verif_check_photos(p -> 'photos', uid), consent_at = now()
    where id = v.id;
  end if;

  if v_method is not null and v.payment_status <> 'confirmed' then
    if v_method not in ('mpesa', 'manual') then raise exception 'invalid payment method' using errcode = '22023'; end if;
    if v_method = 'mpesa' and v_code !~ '^[A-Z0-9]{8,12}$' then raise exception 'invalid M-Pesa code' using errcode = '22023'; end if;
    update public.seller_verifications
       set payment_method = v_method, mpesa_code = case when v_method = 'mpesa' then v_code end, payment_status = 'submitted'
     where id = v.id;
  end if;

  update public.seller_verifications
     set status = 'pending', updated_at = now(),
         history = history || public.verif_log('pending', 'seller',
           case when v.status = 'info_requested' then 'Seller sent more information' else 'Seller updated payment details' end)
   where id = v.id;
end;
$$;

-- ---------------------------------------------------------------- admin actions
create or replace function public.admin_verification_action(p_id bigint, p_action text, p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.seller_verifications;
  v_note text := left(btrim(coalesce(p_note, '')), 300);
  v_months int := public.verif_setting_int('verification_months', 12);
  v_label text;
begin
  perform public.require_admin();
  select * into v from public.seller_verifications where id = p_id for update;
  if v.id is null then raise exception 'application not found' using errcode = 'P0002'; end if;

  if p_action = 'confirm_payment' and v.payment_status <> 'confirmed' and v.status in ('pending', 'info_requested') then
    update public.seller_verifications set payment_status = 'confirmed', payment_confirmed_at = now(),
      payment_method = coalesce(payment_method, 'manual') where id = v.id;
    v_label := 'payment_confirmed';
  elsif p_action = 'reject_payment' and v.payment_status in ('unpaid', 'submitted') and v.status in ('pending', 'info_requested') then
    if v_note = '' then raise exception 'add a note for the seller' using errcode = '22023'; end if;
    update public.seller_verifications set payment_status = 'rejected', status = 'info_requested', admin_note = v_note where id = v.id;
    v_label := 'payment_rejected';
  elsif p_action = 'approve' and v.status = 'pending' then
    if v.payment_status <> 'confirmed' then raise exception 'confirm payment before approving' using errcode = '22023'; end if;
    update public.seller_verifications set status = 'approved', approved_at = now(),
      expires_at = now() + make_interval(months => v_months), admin_note = v_note where id = v.id;
    v_label := 'approved';
  elsif p_action = 'reject' and v.status in ('pending', 'info_requested') then
    if v_note = '' then raise exception 'add a reason for the seller' using errcode = '22023'; end if;
    update public.seller_verifications set status = 'rejected', admin_note = v_note where id = v.id;
    v_label := 'rejected';
  elsif p_action = 'request_info' and v.status in ('pending', 'info_requested') then
    if v_note = '' then raise exception 'say what information is needed' using errcode = '22023'; end if;
    update public.seller_verifications set status = 'info_requested', admin_note = v_note where id = v.id;
    v_label := 'info_requested';
  elsif p_action = 'suspend' and v.status = 'approved' then
    if v_note = '' then raise exception 'add a reason' using errcode = '22023'; end if;
    update public.seller_verifications set status = 'suspended', admin_note = v_note where id = v.id;
    v_label := 'suspended';
  elsif p_action = 'reinstate' and v.status = 'suspended' then
    update public.seller_verifications set status = 'approved', admin_note = v_note where id = v.id;
    v_label := 'reinstated';
  elsif p_action = 'revoke' and v.status in ('approved', 'suspended') then
    if v_note = '' then raise exception 'add a reason' using errcode = '22023'; end if;
    update public.seller_verifications set status = 'revoked', admin_note = v_note where id = v.id;
    v_label := 'revoked';
  else
    raise exception 'this action is not possible now' using errcode = '22023';
  end if;

  update public.seller_verifications set updated_at = now(), history = history || public.verif_log(v_label, 'admin', v_note)
   where id = v.id;
end;
$$;

create or replace function public.admin_set_verification_settings(p_fee int, p_months int, p_payment_info text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  if p_fee is null or p_fee not between 0 and 100000 then raise exception 'invalid fee' using errcode = '22023'; end if;
  if p_months is null or p_months not between 1 and 36 then raise exception 'invalid validity' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_payment_info, ''))) not between 10 and 500 then raise exception 'invalid payment instructions' using errcode = '22023'; end if;
  insert into public.app_settings (key, value, updated_at) values
    ('verification_fee', to_jsonb(p_fee), now()), ('verification_months', to_jsonb(p_months), now()),
    ('verification_payment_info', to_jsonb(btrim(p_payment_info)), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$$;

-- ---------------------------------------------------------------- grants
revoke all on function public.verif_check_photos(jsonb, uuid), public.verif_setting_int(text, int) from public, anon, authenticated;
revoke all on function public.submit_verification(jsonb), public.update_verification(bigint, jsonb),
  public.admin_verification_action(bigint, text, text), public.admin_set_verification_settings(int, int, text) from public, anon;
grant execute on function public.submit_verification(jsonb), public.update_verification(bigint, jsonb),
  public.admin_verification_action(bigint, text, text), public.admin_set_verification_settings(int, int, text) to authenticated;
grant execute on function public.verified_sellers() to anon, authenticated;

revoke all on public.app_settings, public.seller_verifications from anon;
revoke insert, update, delete on public.app_settings, public.seller_verifications from authenticated;
grant select on public.app_settings to anon, authenticated;
grant select on public.seller_verifications to authenticated;
