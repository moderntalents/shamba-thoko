-- Final business rules for Verified Seller: 90-day wait after revocation, permanent blocks for fraud,
-- mandatory inspection of all four photos before approval, automatic data retention with an audit trail.
-- Nothing is deleted that is under a legal hold, still open, suspended (under investigation) or within its period.

-- ---------------------------------------------------------------- records outlive the account
-- Verification records must be kept for their retention period even if the seller deletes their account.
alter table public.seller_verifications alter column seller drop not null;
alter table public.seller_verifications drop constraint if exists seller_verifications_seller_fkey;
alter table public.seller_verifications add constraint seller_verifications_seller_fkey
  foreign key (seller) references public.profiles (id) on delete set null;

alter table public.seller_verifications
  add column if not exists closed_at timestamptz,          -- when rejected / revoked / withdrawn / superseded
  add column if not exists details_at timestamptz not null default now(), -- last time the seller changed details or photos
  add column if not exists purged_at timestamptz;          -- when personal data and photos were deleted
-- Redacted records keep an empty phone and placeholder ID.
alter table public.seller_verifications drop constraint if exists seller_verifications_phone_check;
alter table public.seller_verifications add constraint seller_verifications_phone_check
  check (phone ~ '^254[17][0-9]{8}$' or (purged_at is not null and phone = ''));

-- ---------------------------------------------------------------- admin-only data
-- Fraud flags, legal holds and photo inspections are kept apart so the seller never sees them.
create table public.verification_cases (
  application_id bigint primary key references public.seller_verifications (id) on delete cascade,
  fraud boolean not null default false,
  legal_hold boolean not null default false,
  hold_note text not null default '',
  photo_reviews jsonb not null default '{}'::jsonb,   -- {face_front: {by, at}, ...}
  updated_at timestamptz not null default now()
);
alter table public.verification_cases enable row level security;
create policy "admins read cases" on public.verification_cases for select to authenticated using ((select public.is_admin()));

-- Permanent blocks. Kept even after the account is deleted (identified by phone and ID), for up to 5 years.
create table public.verification_blocks (
  id bigint generated always as identity primary key,
  seller uuid references public.profiles (id) on delete set null,
  phone text,
  id_type text,
  id_number text,
  reason text not null,
  application_id bigint references public.seller_verifications (id) on delete set null,
  blocked_by uuid,
  blocked_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_by uuid,
  lift_note text,
  redacted_at timestamptz
);
create index verification_blocks_active_idx on public.verification_blocks (id_number) where lifted_at is null;
alter table public.verification_blocks enable row level security;
create policy "admins read blocks" on public.verification_blocks for select to authenticated using ((select public.is_admin()));

-- Append-only audit trail. Nobody can edit or delete entries through the API.
create table public.verification_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  action text not null,
  application_id bigint,
  actor uuid,
  actor_kind text not null default 'admin',   -- admin / seller / system
  detail jsonb not null default '{}'::jsonb
);
create index verification_audit_app_idx on public.verification_audit (application_id, at desc);
alter table public.verification_audit enable row level security;
create policy "admins read audit" on public.verification_audit for select to authenticated using ((select public.is_admin()));

-- Files waiting for secure deletion through the Storage API (SQL cannot delete storage files directly).
create table public.verification_purge_queue (
  id bigint generated always as identity primary key,
  application_id bigint,
  path text not null,
  reason text not null,
  queued_at timestamptz not null default now(),
  done_at timestamptz
);
alter table public.verification_purge_queue enable row level security;
create policy "admins read purge queue" on public.verification_purge_queue for select to authenticated using ((select public.is_admin()));

revoke all on public.verification_cases, public.verification_blocks, public.verification_audit, public.verification_purge_queue from anon, authenticated;
grant select on public.verification_cases, public.verification_blocks, public.verification_audit, public.verification_purge_queue to authenticated;

insert into public.verification_cases (application_id) select id from public.seller_verifications on conflict do nothing;

-- ---------------------------------------------------------------- helpers
create or replace function public.verif_audit(p_action text, p_app bigint, p_detail jsonb default '{}'::jsonb, p_kind text default null)
returns void language sql security definer set search_path = '' as $$
  insert into public.verification_audit (action, application_id, actor, actor_kind, detail)
  values (p_action, p_app, (select auth.uid()),
          coalesce(p_kind, case when (select auth.uid()) is null then 'system' when public.is_admin() then 'admin' else 'seller' end),
          coalesce(p_detail, '{}'::jsonb));
$$;

-- Retention jobs run as the database owner (scheduled job) or with the service key (Edge Function) or by an admin.
create or replace function public.verif_require_system_or_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if session_user in ('postgres', 'supabase_admin') then return; end if;
  if coalesce((select auth.jwt()) ->> 'role', '') = 'service_role' then return; end if;
  perform public.require_admin();
end;
$$;

-- Is this person currently blocked (by account, phone or ID), or within the 90-day wait after a revocation?
create or replace function public.verif_eligibility(p_uid uuid, p_phone text, p_id_type text, p_id_number text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_until timestamptz;
begin
  if exists (select 1 from public.verification_blocks b
              where b.lifted_at is null and b.redacted_at is null
                and (b.seller = p_uid or b.phone = p_phone or (b.id_type = p_id_type and b.id_number = upper(btrim(p_id_number))))) then
    return 'blocked';
  end if;
  select max(v.closed_at) + interval '90 days' into v_until from public.seller_verifications v
   where v.status = 'revoked' and v.closed_at is not null
     and (v.seller = p_uid or (v.purged_at is null and v.id_type = p_id_type and v.id_number = upper(btrim(p_id_number))));
  if v_until is not null and v_until > now() then return 'wait:' || to_char(v_until at time zone 'Africa/Nairobi', 'YYYY-MM-DD'); end if;
  return 'ok';
end;
$$;

-- Photos stay protected from seller deletion until the record is purged.
create or replace function public.verif_photo_in_use(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.seller_verifications v, jsonb_each_text(v.photos) e
                  where e.value = p_name and v.purged_at is null);
$$;

-- ---------------------------------------------------------------- seller functions (replace)
create or replace function public.submit_verification(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  me public.profiles;
  cur public.seller_verifications;
  v_phone text := regexp_replace(coalesce(p ->> 'phone', ''), '[\s-]', '', 'g');
  v_code text := upper(btrim(coalesce(p ->> 'mpesa_code', '')));
  v_method text := nullif(p ->> 'payment_method', '');
  v_elig text; v_id bigint; n int;
begin
  select * into me from public.profiles where id = uid;
  if me.id is null or me.role <> 'seller' then raise exception 'seller account required' using errcode = '42501'; end if;
  if coalesce((p ->> 'consent')::boolean, false) is not true then raise exception 'consent required' using errcode = '22023'; end if;
  if v_phone ~ '^(\+?254|0)[17][0-9]{8}$' then v_phone := '254' || right(v_phone, 9);
  else raise exception 'invalid phone' using errcode = '22023'; end if;
  v_elig := public.verif_eligibility(uid, v_phone, p ->> 'id_type', p ->> 'id_number');
  if v_elig = 'blocked' then raise exception 'you cannot apply for verification: contact support' using errcode = '42501'; end if;
  if v_elig like 'wait:%' then raise exception 'you can apply again from %', substr(v_elig, 6) using errcode = '42501'; end if;
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
  if v_method is not null and v_method not in ('mpesa', 'manual') then raise exception 'invalid payment method' using errcode = '22023'; end if;
  if v_method = 'mpesa' and v_code !~ '^[A-Z0-9]{8,12}$' then raise exception 'invalid M-Pesa code' using errcode = '22023'; end if;
  if v_method = 'mpesa' and exists (select 1 from public.seller_verifications where mpesa_code = v_code) then
    raise exception 'this M-Pesa code was already used' using errcode = '22023';
  end if;

  insert into public.seller_verifications
    (seller, legal_name, phone, id_type, id_number, business_name, county, location, products, photos, consent_at, fee,
     payment_method, mpesa_code, payment_status, history, details_at)
  values (uid, regexp_replace(btrim(p ->> 'legal_name'), '\s+', ' ', 'g'), v_phone, p ->> 'id_type', upper(btrim(p ->> 'id_number')),
          btrim(p ->> 'business_name'), p ->> 'county', btrim(p ->> 'location'), btrim(p ->> 'products'),
          public.verif_check_photos(p -> 'photos', uid, null), now(), public.verif_setting_int('verification_fee', 500),
          v_method, case when v_method = 'mpesa' then v_code end,
          case when v_method is null then 'unpaid' else 'submitted' end,
          public.verif_log('pending', 'seller', case when cur.id is null then 'Application submitted' else 'Renewal submitted' end), now())
  returning id into v_id;
  insert into public.verification_cases (application_id) values (v_id);
  perform public.verif_audit('submitted', v_id, jsonb_build_object('renewal', cur.id is not null));
  return v_id;
end;
$$;

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
    if public.verif_eligibility(uid, v_phone, p ->> 'id_type', p ->> 'id_number') = 'blocked' then
      raise exception 'you cannot apply for verification: contact support' using errcode = '42501';
    end if;
    -- The old photos stay attached to the old version only through the audit trail; queue them for deletion.
    insert into public.verification_purge_queue (application_id, path, reason)
      select v.id, e.value, 'replaced by seller' from jsonb_each_text(v.photos) e
       where e.value not in (select x.value from jsonb_each_text(coalesce(p -> 'photos', '{}'::jsonb)) x);
    update public.seller_verifications set
      legal_name = regexp_replace(btrim(p ->> 'legal_name'), '\s+', ' ', 'g'), phone = v_phone,
      id_type = p ->> 'id_type', id_number = upper(btrim(p ->> 'id_number')),
      business_name = btrim(p ->> 'business_name'), county = p ->> 'county', location = btrim(p ->> 'location'),
      products = btrim(p ->> 'products'), photos = public.verif_check_photos(p -> 'photos', uid, v.id), consent_at = now(),
      details_at = now()
    where id = v.id;
    -- New photos must be inspected again.
    update public.verification_cases set photo_reviews = '{}'::jsonb, updated_at = now() where application_id = v.id;
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
  perform public.verif_audit(case when p ? 'legal_name' then 'seller_updated_details' else 'seller_added_payment' end, v.id);
end;
$$;

create or replace function public.withdraw_my_verifications() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); r record;
begin
  if uid is null then raise exception 'sign in required' using errcode = '42501'; end if;
  if exists (select 1 from public.seller_verifications where seller = uid and status = 'suspended') then
    raise exception 'verification suspended: contact support to delete your account' using errcode = '42501';
  end if;
  for r in select id from public.seller_verifications where seller = uid and status in ('pending', 'info_requested', 'approved') loop
    update public.seller_verifications
       set status = 'withdrawn', closed_at = now(), updated_at = now(),
           history = history || public.verif_log('withdrawn', 'seller', 'Seller deleted their account')
     where id = r.id;
    perform public.verif_audit('withdrawn', r.id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------- admin functions
-- The admin opens each photo full size; the app records it. Approval needs all four, by the approving admin,
-- after the seller's latest change.
create or replace function public.admin_record_photo_review(p_id bigint, p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.seller_verifications; r jsonb;
begin
  perform public.require_admin();
  if p_key not in ('face_front', 'face_side', 'products', 'with_products') then raise exception 'invalid photo' using errcode = '22023'; end if;
  select * into v from public.seller_verifications where id = p_id;
  if v.id is null or v.purged_at is not null then raise exception 'application not found' using errcode = 'P0002'; end if;
  if v.seller = (select auth.uid()) then raise exception 'admins cannot review their own application' using errcode = '42501'; end if;
  insert into public.verification_cases (application_id) values (v.id) on conflict do nothing;
  update public.verification_cases
     set photo_reviews = photo_reviews || jsonb_build_object(p_key, jsonb_build_object('by', (select auth.uid()), 'at', now())),
         updated_at = now()
   where application_id = v.id
   returning photo_reviews into r;
  perform public.verif_audit('photo_inspected', v.id, jsonb_build_object('photo', p_key));
  return r;
end;
$$;

create or replace function public.admin_verification_action(p_id bigint, p_action text, p_note text default '', p_seen timestamptz default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.seller_verifications;
  c public.verification_cases;
  v_note text := left(btrim(coalesce(p_note, '')), 300);
  v_months int := public.verif_setting_int('verification_months', 12);
  v_label text;
  v_prev timestamptz;
  k text;
begin
  perform public.require_admin();
  select * into v from public.seller_verifications where id = p_id for update;
  if v.id is null then raise exception 'application not found' using errcode = 'P0002'; end if;
  if v.seller = (select auth.uid()) then raise exception 'admins cannot review their own application' using errcode = '42501'; end if;
  if p_seen is null or date_trunc('milliseconds', v.updated_at) <> date_trunc('milliseconds', p_seen) then
    raise exception 'this application changed: reload and check it again' using errcode = 'P0001'; -- not 40001: the API would retry it forever
  end if;
  if v.purged_at is not null then raise exception 'this record was purged' using errcode = '22023'; end if;
  insert into public.verification_cases (application_id) values (v.id) on conflict do nothing;
  select * into c from public.verification_cases where application_id = v.id;

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
    foreach k in array array['face_front', 'face_side', 'products', 'with_products'] loop
      if (c.photo_reviews -> k ->> 'by') is distinct from (select auth.uid())::text
         or (c.photo_reviews -> k ->> 'at')::timestamptz < v.details_at then
        raise exception 'open and inspect all four photos before approving' using errcode = '22023';
      end if;
    end loop;
    if exists (select 1 from public.seller_verifications where seller = v.seller and status = 'suspended') then
      raise exception 'this seller has a suspended verification' using errcode = '22023';
    end if;
    if public.verif_eligibility(v.seller, v.phone, v.id_type, v.id_number) = 'blocked' then
      raise exception 'this seller is blocked' using errcode = '22023';
    end if;
    perform public.verif_check_id(v.id_type, v.id_number, v.seller);
    if exists (select 1 from jsonb_each_text(v.photos) e
                where not exists (select 1 from storage.objects o where o.bucket_id = 'verification-photos' and o.name = e.value)) then
      raise exception 'a verification photo is missing: request new photos' using errcode = '22023';
    end if;
    select max(expires_at) into v_prev from public.seller_verifications
     where seller = v.seller and status = 'approved' and id <> v.id and expires_at > now();
    update public.seller_verifications set status = 'superseded', closed_at = now(), updated_at = now(),
           history = history || public.verif_log('superseded', 'admin', 'Replaced by renewal #' || v.id, (select auth.uid()))
     where seller = v.seller and status = 'approved' and id <> v.id;
    update public.seller_verifications set status = 'approved', approved_at = now(),
      expires_at = greatest(now(), coalesce(v_prev, now())) + make_interval(months => v_months), admin_note = v_note where id = v.id;
    v_label := 'approved';
  elsif p_action = 'reject' and v.status in ('pending', 'info_requested') then
    if v_note = '' then raise exception 'add a reason for the seller' using errcode = '22023'; end if;
    update public.seller_verifications set status = 'rejected', closed_at = now(), admin_note = v_note where id = v.id;
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
    update public.seller_verifications set status = 'revoked', closed_at = now(), admin_note = v_note where id = v.id;
    v_label := 'revoked';
  elsif p_action = 'block' then
    -- Fraud: close the application, mark the case as fraud (kept up to 5 years) and block the person permanently.
    if v_note = '' then raise exception 'add the reason for the block' using errcode = '22023'; end if;
    if v.status in ('pending', 'info_requested', 'approved', 'suspended') then
      update public.seller_verifications set status = 'revoked', closed_at = now(), admin_note = 'Verification ended: contact support' where id = v.id;
    else
      update public.seller_verifications set closed_at = coalesce(closed_at, now()) where id = v.id;
    end if;
    update public.verification_cases set fraud = true, updated_at = now() where application_id = v.id;
    insert into public.verification_blocks (seller, phone, id_type, id_number, reason, application_id, blocked_by)
    values (v.seller, v.phone, v.id_type, v.id_number, v_note, v.id, (select auth.uid()));
    v_label := 'blocked';
  else
    raise exception 'this action is not possible now' using errcode = '22023';
  end if;

  update public.seller_verifications
     set updated_at = now(),
         history = history || public.verif_log(case when v_label = 'blocked' then 'revoked' else v_label end, 'admin',
                                               case when v_label = 'blocked' then '' else v_note end, (select auth.uid()))
   where id = v.id;
  perform public.verif_audit(v_label, v.id, jsonb_build_object('note', v_note));
end;
$$;

create or replace function public.admin_set_legal_hold(p_id bigint, p_hold boolean, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  if p_hold and char_length(btrim(coalesce(p_note, ''))) < 5 then raise exception 'say why the record must be kept' using errcode = '22023'; end if;
  if not exists (select 1 from public.seller_verifications where id = p_id) then raise exception 'application not found' using errcode = 'P0002'; end if;
  insert into public.verification_cases (application_id) values (p_id) on conflict do nothing;
  update public.verification_cases set legal_hold = p_hold, hold_note = case when p_hold then btrim(p_note) else '' end, updated_at = now()
   where application_id = p_id;
  perform public.verif_audit(case when p_hold then 'legal_hold_on' else 'legal_hold_off' end, p_id, jsonb_build_object('note', left(coalesce(p_note, ''), 300)));
end;
$$;

create or replace function public.admin_set_fraud(p_id bigint, p_fraud boolean, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  if char_length(btrim(coalesce(p_note, ''))) < 5 then raise exception 'add a note' using errcode = '22023'; end if;
  insert into public.verification_cases (application_id) values (p_id) on conflict do nothing;
  update public.verification_cases set fraud = p_fraud, updated_at = now() where application_id = p_id;
  perform public.verif_audit(case when p_fraud then 'fraud_marked' else 'fraud_cleared' end, p_id, jsonb_build_object('note', left(p_note, 300)));
end;
$$;

create or replace function public.admin_lift_block(p_block bigint, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.verification_blocks;
begin
  perform public.require_admin();
  if char_length(btrim(coalesce(p_note, ''))) < 5 then raise exception 'say why the block is lifted' using errcode = '22023'; end if;
  update public.verification_blocks set lifted_at = now(), lifted_by = (select auth.uid()), lift_note = btrim(p_note)
   where id = p_block and lifted_at is null returning * into b;
  if b.id is null then raise exception 'block not found' using errcode = 'P0002'; end if;
  perform public.verif_audit('block_lifted', b.application_id, jsonb_build_object('block', b.id, 'note', left(p_note, 300)));
end;
$$;

-- ---------------------------------------------------------------- retention
-- Rules (never applied while a record is open, suspended, under legal hold):
--   * never approved (rejected / withdrawn / payment rejected): ID and photos deleted 90 days after closing
--   * approved: kept for the verification period and 12 months after expiry (or after closing, if later)
--   * fraud: kept 5 years after closing
-- Purging deletes the ID number, phone, legal name, location and photos; the record outline and audit trail stay.
create or replace function public.verification_retention_due() returns table (application_id bigint, rule text)
language sql stable security definer set search_path = '' as $$
  select v.id,
         case when coalesce(c.fraud, false) then 'fraud_5_years'
              when v.approved_at is not null then 'approved_12_months_after_expiry'
              else 'not_approved_90_days' end
    from public.seller_verifications v
    left join public.verification_cases c on c.application_id = v.id
   where v.purged_at is null
     and not coalesce(c.legal_hold, false)
     and v.status not in ('pending', 'info_requested', 'suspended')
     and not exists (select 1 from public.verification_blocks b
                      where b.application_id = v.id and b.lifted_at is null and b.redacted_at is null
                        and b.blocked_at > now() - interval '5 years')
     and case
           when coalesce(c.fraud, false) then coalesce(v.closed_at, v.updated_at) < now() - interval '5 years'
           when v.approved_at is not null then
             greatest(coalesce(v.expires_at, v.closed_at), coalesce(v.closed_at, v.expires_at)) < now() - interval '12 months'
           else coalesce(v.closed_at, v.updated_at) < now() - interval '90 days'
         end;
$$;

create or replace function public.verification_retention_run() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; n_rec int := 0; n_files int := 0; n_blocks int := 0; k int;
begin
  perform public.verif_require_system_or_admin();
  for r in select * from public.verification_retention_due() loop
    insert into public.verification_purge_queue (application_id, path, reason)
      select r.application_id, e.value, r.rule
        from public.seller_verifications v, jsonb_each_text(v.photos) e where v.id = r.application_id;
    get diagnostics k = row_count; n_files := n_files + k;
    update public.seller_verifications
       set id_number = 'REDACTED', phone = '', legal_name = 'Redacted', location = 'Redacted', photos = '{}'::jsonb,
           purged_at = now(),
           history = history || jsonb_build_array(jsonb_build_object('s', 'purged', 'by', 'system', 'at', public.ms_now(), 'note', r.rule))
     where id = r.application_id;
    perform public.verif_audit('purged', r.application_id, jsonb_build_object('rule', r.rule), 'system');
    n_rec := n_rec + 1;
  end loop;
  -- Blocks keep identifying details for at most 5 years.
  for r in select id, application_id from public.verification_blocks
            where redacted_at is null and blocked_at < now() - interval '5 years' loop
    update public.verification_blocks set phone = null, id_number = null, redacted_at = now() where id = r.id;
    perform public.verif_audit('block_redacted', r.application_id, jsonb_build_object('block', r.id), 'system');
    n_blocks := n_blocks + 1;
  end loop;
  return jsonb_build_object('records_purged', n_rec, 'files_queued', n_files, 'blocks_redacted', n_blocks);
end;
$$;

create or replace function public.verification_purge_pending(p_limit int default 200) returns table (id bigint, path text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.verif_require_system_or_admin();
  return query select q.id, q.path from public.verification_purge_queue q where q.done_at is null order by q.id limit least(p_limit, 500);
end;
$$;

create or replace function public.verification_purge_done(p_ids bigint[]) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform public.verif_require_system_or_admin();
  update public.verification_purge_queue set done_at = now() where id = any (p_ids) and done_at is null;
  get diagnostics n = row_count;
  if n > 0 then perform public.verif_audit('files_deleted', null, jsonb_build_object('count', n)); end if;
  return n;
end;
$$;

-- ---------------------------------------------------------------- grants
revoke all on function public.verif_audit(text, bigint, jsonb, text), public.verif_require_system_or_admin(),
  public.verif_eligibility(uuid, text, text, text), public.verification_retention_due() from public, anon, authenticated;
revoke all on function public.admin_record_photo_review(bigint, text), public.admin_set_legal_hold(bigint, boolean, text),
  public.admin_set_fraud(bigint, boolean, text), public.admin_lift_block(bigint, text), public.verification_retention_run(),
  public.verification_purge_pending(int), public.verification_purge_done(bigint[]) from public, anon;
grant execute on function public.admin_record_photo_review(bigint, text), public.admin_set_legal_hold(bigint, boolean, text),
  public.admin_set_fraud(bigint, boolean, text), public.admin_lift_block(bigint, text), public.verification_retention_run(),
  public.verification_purge_pending(int), public.verification_purge_done(bigint[]) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.verification_retention_run(), public.verification_purge_pending(int),
      public.verification_purge_done(bigint[]) to service_role;
  end if;
end $$;
