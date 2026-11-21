-- Security hardening for the Verified Seller feature (from the pre-merge security review).
-- Tightens rules only; no existing data is removed.

-- 1. Public settings: only the verification settings are readable, so future private settings never leak.
drop policy if exists "settings are public" on public.app_settings;
create policy "verification settings are public" on public.app_settings for select to anon, authenticated
  using (key in ('verification_fee', 'verification_months', 'verification_payment_info'));

-- 2. New status for applications closed by the seller (for example when deleting their account).
alter table public.seller_verifications drop constraint if exists seller_verifications_status_check;
alter table public.seller_verifications add constraint seller_verifications_status_check
  check (status in ('pending', 'info_requested', 'approved', 'rejected', 'suspended', 'revoked', 'withdrawn', 'superseded'));

-- One open application per seller, even if two are sent at the same moment.
create unique index if not exists seller_verifications_one_open
  on public.seller_verifications (seller) where status in ('pending', 'info_requested');

-- 3. One M-Pesa code can only be used for one application.
create unique index if not exists seller_verifications_mpesa_code_key
  on public.seller_verifications (mpesa_code) where mpesa_code is not null;

-- 4. Names cannot contain check-mark symbols that imitate the blue tick.
alter table public.profiles add constraint profiles_no_tick check (name !~ '[✓✔☑✅🗸√]' and biz !~ '[✓✔☑✅🗸√]');
alter table public.listings add constraint listings_no_tick check (name !~ '[✓✔☑✅🗸√]' and seller_name !~ '[✓✔☑✅🗸√]');
alter table public.seller_verifications add constraint seller_verifications_no_tick
  check (legal_name !~ '[✓✔☑✅🗸√]' and business_name !~ '[✓✔☑✅🗸√]');

-- 5. Storage helpers and stricter photo policies.
create or replace function public.verif_photo_count(p_uid uuid) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from storage.objects
   where bucket_id = 'verification-photos' and name like p_uid::text || '/%';
$$;
-- A photo is "in use" while it belongs to an application that is open or active.
create or replace function public.verif_photo_in_use(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.seller_verifications v, jsonb_each_text(v.photos) e
                  where e.value = p_name and v.status in ('pending', 'info_requested', 'approved', 'suspended'));
$$;
revoke all on function public.verif_photo_count(uuid), public.verif_photo_in_use(text) from public, anon;
grant execute on function public.verif_photo_count(uuid), public.verif_photo_in_use(text) to authenticated;

drop policy if exists "sellers upload verification photos to own folder" on storage.objects;
create policy "sellers upload verification photos to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'verification-photos' and (storage.foldername(name))[1] = (select auth.uid())::text
              and (select public.is_seller()) and public.verif_photo_count((select auth.uid())) < 24);
drop policy if exists "sellers and admins delete verification photos" on storage.objects;
create policy "sellers and admins delete verification photos" on storage.objects for delete to authenticated
  using (bucket_id = 'verification-photos' and ((select public.is_admin())
         or ((storage.foldername(name))[1] = (select auth.uid())::text and not public.verif_photo_in_use(name))));

-- 6. Photos must be fresh (uploaded in the last 24 hours) and never reused from an earlier application.
--    The ID number cannot be on an open or active application of a different seller.
drop function if exists public.verif_check_photos(jsonb, uuid);
create or replace function public.verif_check_photos(p_photos jsonb, p_uid uuid, p_app bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare k text; v text; seen text[] := '{}';
begin
  if jsonb_typeof(p_photos) <> 'object' then raise exception 'photos required' using errcode = '22023'; end if;
  foreach k in array array['face_front', 'face_side', 'products', 'with_products'] loop
    v := p_photos ->> k;
    if v is null or v !~ ('^' || p_uid::text || '/[a-z_]{5,14}-[0-9a-f]{24}\.jpg$') or v = any (seen)
       or not exists (select 1 from storage.objects where bucket_id = 'verification-photos' and name = v
                       and created_at > now() - interval '24 hours') then
      raise exception 'photo % missing, old or invalid: take a new photo', k using errcode = '22023';
    end if;
    if exists (select 1 from public.seller_verifications a, jsonb_each_text(a.photos) e
                where e.value = v and a.id is distinct from p_app) then
      raise exception 'photo % was already used: take a new photo', k using errcode = '22023';
    end if;
    seen := seen || v;
  end loop;
  return jsonb_build_object('face_front', p_photos ->> 'face_front', 'face_side', p_photos ->> 'face_side',
                            'products', p_photos ->> 'products', 'with_products', p_photos ->> 'with_products');
end;
$$;

-- Checked only when an admin approves (so applicants cannot use it to test whether an ID is registered).
create or replace function public.verif_check_id(p_id_type text, p_id_number text, p_uid uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from public.seller_verifications
              where id_type = p_id_type and id_number = upper(btrim(p_id_number)) and seller <> p_uid
                and status in ('approved', 'suspended')) then
    raise exception 'this ID number is already verified for another seller' using errcode = '22023';
  end if;
end;
$$;

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
    if exists (select 1 from public.seller_verifications where seller = uid and status = 'suspended') then
      raise exception 'verification suspended: contact support' using errcode = '42501';
    end if;
    if cur.status = 'approved' and cur.expires_at > now() + interval '30 days' then
      raise exception 'renewal opens 30 days before expiry' using errcode = '22023';
    end if;
  end if;
  if v_phone ~ '^(\+?254|0)[17][0-9]{8}$' then v_phone := '254' || right(v_phone, 9);
  else raise exception 'invalid phone' using errcode = '22023'; end if;
  if v_method is not null and v_method not in ('mpesa', 'manual') then raise exception 'invalid payment method' using errcode = '22023'; end if;
  if v_method = 'mpesa' and v_code !~ '^[A-Z0-9]{8,12}$' then raise exception 'invalid M-Pesa code' using errcode = '22023'; end if;
  if v_method = 'mpesa' and exists (select 1 from public.seller_verifications where mpesa_code = v_code) then
    raise exception 'this M-Pesa code was already used' using errcode = '22023';
  end if;
  insert into public.seller_verifications
    (seller, legal_name, phone, id_type, id_number, business_name, county, location, products, photos, consent_at, fee,
     payment_method, mpesa_code, payment_status, history)
  values (uid, regexp_replace(btrim(p ->> 'legal_name'), '\s+', ' ', 'g'), v_phone, p ->> 'id_type', upper(btrim(p ->> 'id_number')),
          btrim(p ->> 'business_name'), p ->> 'county', btrim(p ->> 'location'), btrim(p ->> 'products'),
          public.verif_check_photos(p -> 'photos', uid, null), now(), public.verif_setting_int('verification_fee', 500),
          v_method, case when v_method = 'mpesa' then v_code end,
          case when v_method is null then 'unpaid' else 'submitted' end,
          public.verif_log('pending', 'seller', case when cur.id is null then 'Application submitted' else 'Renewal submitted' end))
  returning id into v_id;
  return v_id;
end;
$$;

-- Details (and photos) can only be changed when an admin has asked for more information.
-- While the application is pending, the seller can only add payment details.
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
    if v.status <> 'info_requested' then raise exception 'details can only be changed when Shamba Soko asks for more information' using errcode = '22023'; end if;
    if coalesce((p ->> 'consent')::boolean, false) is not true then raise exception 'consent required' using errcode = '22023'; end if;
    if v_phone ~ '^(\+?254|0)[17][0-9]{8}$' then v_phone := '254' || right(v_phone, 9);
    else raise exception 'invalid phone' using errcode = '22023'; end if;
    update public.seller_verifications set
      legal_name = regexp_replace(btrim(p ->> 'legal_name'), '\s+', ' ', 'g'), phone = v_phone,
      id_type = p ->> 'id_type', id_number = upper(btrim(p ->> 'id_number')),
      business_name = btrim(p ->> 'business_name'), county = p ->> 'county', location = btrim(p ->> 'location'),
      products = btrim(p ->> 'products'), photos = public.verif_check_photos(p -> 'photos', uid, v.id), consent_at = now()
    where id = v.id;
  elsif v_method is null then
    raise exception 'nothing to update' using errcode = '22023';
  end if;

  if v_method is not null and v.payment_status <> 'confirmed' then
    if v_method not in ('mpesa', 'manual') then raise exception 'invalid payment method' using errcode = '22023'; end if;
    if v_method = 'mpesa' and v_code !~ '^[A-Z0-9]{8,12}$' then raise exception 'invalid M-Pesa code' using errcode = '22023'; end if;
    if v_method = 'mpesa' and exists (select 1 from public.seller_verifications where mpesa_code = v_code and id <> v.id) then
      raise exception 'this M-Pesa code was already used' using errcode = '22023';
    end if;
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

-- Admin actions: an admin cannot act on their own application, and the action is refused if the application
-- changed after the admin loaded it (p_seen), so nobody approves details they have not seen.
drop function if exists public.admin_verification_action(bigint, text, text);
create or replace function public.admin_verification_action(p_id bigint, p_action text, p_note text default '', p_seen timestamptz default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.seller_verifications;
  v_note text := left(btrim(coalesce(p_note, '')), 300);
  v_months int := public.verif_setting_int('verification_months', 12);
  v_label text;
  v_prev timestamptz;
begin
  perform public.require_admin();
  select * into v from public.seller_verifications where id = p_id for update;
  if v.id is null then raise exception 'application not found' using errcode = 'P0002'; end if;
  if v.seller = (select auth.uid()) then raise exception 'admins cannot review their own application' using errcode = '42501'; end if;
  if p_seen is null or date_trunc('milliseconds', v.updated_at) <> date_trunc('milliseconds', p_seen) then
    raise exception 'this application changed: reload and check it again' using errcode = '40001';
  end if;

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
    if exists (select 1 from public.seller_verifications where seller = v.seller and status = 'suspended') then
      raise exception 'this seller has a suspended verification' using errcode = '22023';
    end if;
    perform public.verif_check_id(v.id_type, v.id_number, v.seller);
    if exists (select 1 from jsonb_each_text(v.photos) e
                where not exists (select 1 from storage.objects o where o.bucket_id = 'verification-photos' and o.name = e.value)) then
      raise exception 'a verification photo is missing: request new photos' using errcode = '22023';
    end if;
    -- A renewal continues from the end of the current verification; the older approval is closed.
    select max(expires_at) into v_prev from public.seller_verifications
     where seller = v.seller and status = 'approved' and id <> v.id and expires_at > now();
    update public.seller_verifications set status = 'superseded', updated_at = now(),
           history = history || public.verif_log('superseded', 'admin', 'Replaced by renewal #' || v.id, (select auth.uid()))
     where seller = v.seller and status = 'approved' and id <> v.id;
    update public.seller_verifications set status = 'approved', approved_at = now(),
      expires_at = greatest(now(), coalesce(v_prev, now())) + make_interval(months => v_months), admin_note = v_note where id = v.id;
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

  update public.seller_verifications set updated_at = now(), history = history || public.verif_log(v_label, 'admin', v_note, (select auth.uid()))
   where id = v.id;
end;
$$;

-- The seller closes their applications just before deleting their account, so their photos can then be deleted.
-- Suspended applications are never withdrawn (a suspension cannot be escaped this way): a suspended seller
-- must contact support to delete their account, and cannot apply again.
create or replace function public.withdraw_my_verifications() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in required' using errcode = '42501'; end if;
  if exists (select 1 from public.seller_verifications where seller = uid and status = 'suspended') then
    raise exception 'verification suspended: contact support to delete your account' using errcode = '42501';
  end if;
  update public.seller_verifications
     set status = 'withdrawn', updated_at = now(), history = history || public.verif_log('withdrawn', 'seller', 'Seller deleted their account')
   where seller = uid and status in ('pending', 'info_requested', 'approved');
end;
$$;

-- Account deletion (from the base app) now also refuses while a verification is suspended.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in required' using errcode = '42501'; end if;
  if exists (select 1 from public.seller_verifications where seller = uid and status = 'suspended') then
    raise exception 'verification suspended: contact support to delete your account' using errcode = '42501';
  end if;
  update public.orders set buyer_name = 'Deleted account', buyer_phone = '', address = '' where buyer = uid;
  delete from auth.users where id = uid;
end;
$$;

-- History entries record which admin acted.
create or replace function public.verif_log(p_status text, p_by text, p_note text, p_actor uuid) returns jsonb
language sql stable as $$
  select jsonb_build_array(jsonb_build_object('s', p_status, 'by', p_by, 'at', public.ms_now(), 'note', left(coalesce(p_note, ''), 300), 'actor', p_actor));
$$;

-- ---------------------------------------------------------------- grants
revoke all on function public.verif_check_photos(jsonb, uuid, bigint), public.verif_check_id(text, text, uuid),
  public.verif_log(text, text, text), public.verif_log(text, text, text, uuid) from public, anon, authenticated;
revoke all on public.app_settings, public.seller_verifications from authenticated;
grant select on public.app_settings, public.seller_verifications to authenticated;
revoke all on function public.admin_verification_action(bigint, text, text, timestamptz), public.withdraw_my_verifications() from public, anon;
grant execute on function public.admin_verification_action(bigint, text, text, timestamptz), public.withdraw_my_verifications() to authenticated;
