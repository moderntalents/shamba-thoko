-- Riders: free rider accounts, per-listing delivery options, rider requests and delivery tracking.
-- Additive. Existing buyers, sellers, listings, orders, verification and promotions keep working.
--
-- Delivery rule: the seller chooses per listing who may arrange a rider (seller, buyer or both).
-- The buyer picks one of the enabled options when ordering. That only says who arranges the rider;
-- buyer and seller agree directly who pays the rider, how much and how. No delivery fee is charged here.

-- ---------------------------------------------------------------- rider role
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('buyer', 'seller', 'rider'));

create or replace function public.is_rider() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'rider');
$$;

-- Vehicle and service details for rider accounts (phone, name and home county stay on the profile).
create table public.riders (
  id uuid primary key references public.profiles (id) on delete cascade,
  vehicle text not null default 'motorbike'
    check (vehicle in ('motorbike', 'bicycle', 'tuktuk', 'car', 'pickup', 'truck', 'other')),
  vehicle_details text not null default '' check (char_length(vehicle_details) <= 80),
  base_location text not null default '' check (char_length(base_location) <= 120),
  areas text[] not null default '{}' check (cardinality(areas) <= 10),
  available boolean not null default false,
  suspended boolean not null default false,          -- set by admins only
  admin_note text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.riders enable row level security;
create policy "riders read own row, admins read all" on public.riders for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
revoke all on public.riders from anon, authenticated;
grant select on public.riders to authenticated;

-- Sign-up now accepts riders (free). Same checks as before for buyers and sellers.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_phone text := m ->> 'phone';
  v_role text := case when m ->> 'role' in ('seller', 'rider') then m ->> 'role' else 'buyer' end;
  v_name text := regexp_replace(btrim(coalesce(m ->> 'name', '')), '\s+', ' ', 'g');
  v_biz text := btrim(coalesce(m ->> 'biz', ''));
begin
  if v_phone is null or new.email is distinct from ('p' || v_phone || '@phone.shambasoko.app') then
    raise exception 'phone does not match account' using errcode = '22023';
  end if;
  if v_role = 'seller' and char_length(v_biz) < 2 then
    raise exception 'business name required' using errcode = '22023';
  end if;
  insert into public.profiles (id, name, role, biz, phone, county)
  values (new.id, v_name, v_role, case when v_role = 'seller' then v_biz else '' end, v_phone, m ->> 'county');
  if v_role = 'rider' then
    insert into public.riders (id, areas) values (new.id, array[m ->> 'county']);
  end if;
  return new;
end;
$$;

-- Riders keep their role: they cannot switch to seller from the buyer screen.
create or replace function public.become_seller(p_biz text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if char_length(btrim(coalesce(p_biz, ''))) not between 2 and 40 then
    raise exception 'business name required' using errcode = '22023';
  end if;
  update public.profiles set role = 'seller', biz = btrim(p_biz) where id = (select auth.uid()) and role = 'buyer';
  if not found then raise exception 'only buyer accounts can become sellers' using errcode = '42501'; end if;
end;
$$;

create or replace function public.rider_save_profile(p_vehicle text, p_details text, p_location text, p_areas text[], p_available boolean)
returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); v_areas text[];
begin
  if not exists (select 1 from public.profiles where id = uid and role = 'rider') then
    raise exception 'rider account required' using errcode = '42501';
  end if;
  select coalesce(array_agg(distinct a), '{}') into v_areas from unnest(coalesce(p_areas, '{}')) a;
  if cardinality(v_areas) not between 1 and 10 then raise exception 'choose 1 to 10 delivery areas' using errcode = '22023'; end if;
  if exists (select 1 from unnest(v_areas) a where not exists (select 1 from public.counties c where c.name = a)) then
    raise exception 'unknown county' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_details, ''))) > 80 or char_length(btrim(coalesce(p_location, ''))) > 120 then
    raise exception 'text too long' using errcode = '22023';
  end if;
  update public.riders set vehicle = p_vehicle, vehicle_details = btrim(coalesce(p_details, '')),
         base_location = btrim(coalesce(p_location, '')), areas = v_areas, available = coalesce(p_available, false), updated_at = now()
   where id = uid;
end;
$$;

create or replace function public.rider_set_available(p_available boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.riders set available = coalesce(p_available, false), updated_at = now()
   where id = (select auth.uid()) and exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'rider');
  if not found then raise exception 'rider account required' using errcode = '42501'; end if;
end;
$$;

-- Riders that can be requested now. Signed-in users only; phone numbers are shared only after a rider accepts.
create or replace function public.available_riders(p_county text default null)
returns table (id uuid, name text, county text, areas text[], vehicle text, vehicle_details text, base_location text, verified boolean)
language sql stable security definer set search_path = '' as $$
  select p.id, p.name, p.county, r.areas, r.vehicle, r.vehicle_details, r.base_location,
         exists (select 1 from public.verified_sellers() v where v.seller = p.id)
    from public.riders r join public.profiles p on p.id = r.id and p.role = 'rider'
   where r.available and not r.suspended and (select auth.uid()) is not null and p.id <> (select auth.uid())
     and (p_county is null or p_county = any (r.areas) or p.county = p_county)
   order by 8 desc, p.name
   limit 100;
$$;

-- ---------------------------------------------------------------- verification for riders
-- Riders use the existing verification application, fee, M-Pesa confirmation and admin approval.
create or replace function public.is_seller_or_rider() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role in ('seller', 'rider'));
$$;
drop policy if exists "sellers upload verification photos to own folder" on storage.objects;
create policy "sellers upload verification photos to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'verification-photos' and (storage.foldername(name))[1] = (select auth.uid())::text
              and (select public.is_seller_or_rider()) and public.verif_photo_count((select auth.uid())) < 24);
do $$
declare d text;
begin
  d := pg_get_functiondef('public.submit_verification(jsonb)'::regprocedure);
  d := replace(d, $q$me.role <> 'seller' then raise exception 'seller account required'$q$,
                  $q$me.role not in ('seller', 'rider') then raise exception 'seller or rider account required'$q$);
  if position('''rider''' in d) = 0 then raise exception 'could not extend submit_verification to riders'; end if;
  execute d;
end $$;

-- ---------------------------------------------------------------- per-listing delivery options
alter table public.listings add column if not exists seller_rider boolean not null default true;
alter table public.listings add column if not exists buyer_rider boolean not null default true;
alter table public.listings drop constraint if exists listings_delivery_option;
alter table public.listings add constraint listings_delivery_option check (seller_rider or buyer_rider);

create or replace function public.set_listing_delivery(p_id bigint, p_seller boolean, p_buyer boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (coalesce(p_seller, false) or coalesce(p_buyer, false)) then
    raise exception 'choose at least one delivery option' using errcode = '22023';
  end if;
  update public.listings set seller_rider = p_seller, buyer_rider = p_buyer
   where id = p_id and owner = (select auth.uid());
  if not found then raise exception 'listing not found' using errcode = 'P0002'; end if;
end;
$$;

-- ---------------------------------------------------------------- orders
alter table public.orders drop constraint if exists orders_dm_check;
alter table public.orders add constraint orders_dm_check check (dm in ('boda', 'truck', 'self', 'seller_rider', 'buyer_rider'));

-- Place one order per seller. p_delivery maps each seller id to 'seller' or 'buyer' (who arranges the rider).
-- The option must be enabled on every listing from that seller. No delivery fee is added.
create or replace function public.place_orders_v2(p_items jsonb, p_delivery jsonb, p_address text, p_phone text)
returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  me public.profiles;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[\s-]', '', 'g');
  v_addr text := btrim(coalesce(p_address, ''));
  ids text[] := '{}';
  s record; v_id text; n int; v_who text;
begin
  select * into me from public.profiles where id = uid;
  if me.id is null then raise exception 'sign in required' using errcode = '42501'; end if;
  if me.role = 'seller' then raise exception 'seller accounts cannot order' using errcode = '42501'; end if;
  if me.role = 'rider' then raise exception 'rider accounts cannot order' using errcode = '42501'; end if;
  if v_phone ~ '^(\+?254|0)[17][0-9]{8}$' then v_phone := '254' || right(v_phone, 9);
  else raise exception 'invalid phone' using errcode = '22023'; end if;
  if char_length(v_addr) not between 5 and 120 then raise exception 'invalid address' using errcode = '22023'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception 'empty cart' using errcode = '22023';
  end if;
  if jsonb_typeof(p_delivery) <> 'object' then raise exception 'choose delivery' using errcode = '22023'; end if;
  select count(*) into n from public.orders where buyer = uid and created_at > now() - interval '1 hour';
  if n >= 20 then raise exception 'too many orders, try later' using errcode = 'P0001'; end if;

  create temp table _cart on commit drop as
    select l.id, l.owner, l.seller_name, l.name, l.price, l.unit, l.seller_rider, l.buyer_rider, (e ->> 'q')::int as q
      from jsonb_array_elements(p_items) e
      join public.listings l on l.id = (e ->> 'id')::bigint
     where not l.hidden;
  if (select count(*) from _cart) <> jsonb_array_length(p_items)
     or exists (select 1 from _cart where q is null or q not between 1 and 99) then
    raise exception 'some items are no longer available' using errcode = '22023';
  end if;
  if exists (select 1 from _cart where owner = uid) then
    raise exception 'cannot order own listing' using errcode = '22023';
  end if;

  for s in select owner, min(seller_name) sn, sum(price * q)::int sub, bool_and(seller_rider) sr, bool_and(buyer_rider) br,
                  jsonb_agg(jsonb_build_object('id', id, 'n', name, 'q', q, 'p', price, 'u', unit) order by id) items
             from _cart group by owner loop
    v_who := p_delivery ->> s.owner::text;
    if v_who is null or v_who not in ('seller', 'buyer') then raise exception 'choose who arranges the rider' using errcode = '22023'; end if;
    if (v_who = 'seller' and not s.sr) or (v_who = 'buyer' and not s.br) then
      raise exception 'this delivery option is not offered for these items' using errcode = '22023';
    end if;
    insert into public.orders (buyer, buyer_name, buyer_phone, seller, seller_name, items, sub, fee, dm, total, address, log)
    values (uid, me.name, v_phone, s.owner, s.sn, s.items, s.sub, 0, v_who || '_rider', s.sub, v_addr,
            jsonb_build_array(jsonb_build_object('s', 'placed', 'at', public.ms_now(), 'by', 'b')))
    returning id into v_id;
    ids := ids || v_id;
  end loop;
  return ids;
end;
$$;
-- The old checkout (fixed delivery fees) is switched off in 20261123000100_riders_checkout.sql, applied with the new app.

-- ---------------------------------------------------------------- deliveries
create table public.deliveries (
  id bigint generated always as identity primary key,
  order_id text not null references public.orders (id) on delete cascade,
  buyer uuid references public.profiles (id) on delete set null,
  seller uuid references public.profiles (id) on delete set null,
  rider uuid references public.profiles (id) on delete set null,
  rider_name text not null,
  requested_by text not null check (requested_by in ('buyer', 'seller')),
  pickup text not null,        -- seller's county
  dropoff text not null,       -- buyer's delivery address
  items text not null,
  note text not null default '' check (char_length(note) <= 200),
  status text not null default 'requested'
    check (status in ('requested', 'accepted', 'collected', 'in_transit', 'delivered', 'cancelled', 'declined')),
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index deliveries_one_open_per_order on public.deliveries (order_id)
  where status in ('requested', 'accepted', 'collected', 'in_transit');
create index deliveries_rider_idx on public.deliveries (rider, created_at desc);
create index deliveries_order_idx on public.deliveries (order_id);
alter table public.deliveries enable row level security;
create policy "parties and admins read deliveries" on public.deliveries for select to authenticated
  using (rider = (select auth.uid()) or buyer = (select auth.uid()) or seller = (select auth.uid()) or (select public.is_admin()));
revoke all on public.deliveries from anon, authenticated;
grant select on public.deliveries to authenticated;
alter publication supabase_realtime add table public.deliveries;

-- In-app notifications reuse the existing table (the "seller" column is the recipient).
alter table public.seller_notifications add column if not exists delivery_id bigint references public.deliveries (id) on delete set null;
alter table public.seller_notifications add column if not exists ref text;

create or replace function public.delivery_notify(p_d public.deliveries, p_kind text, p_to text[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.seller_notifications (seller, delivery_id, kind, ref)
  select x.uid, p_d.id, p_kind, p_d.order_id
    from (select case w when 'buyer' then p_d.buyer when 'seller' then p_d.seller when 'rider' then p_d.rider end uid
            from unnest(p_to) w) x
   where x.uid is not null and x.uid is distinct from (select auth.uid());
end;
$$;

create or replace function public.delivery_log(p_status text, p_by text, p_note text default '') returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_array(jsonb_build_object('s', p_status, 'by', p_by, 'at', public.ms_now(), 'note', left(coalesce(p_note, ''), 200)));
$$;

-- The party responsible for arranging the rider (from the order) requests one available rider.
create or replace function public.delivery_request(p_order text, p_rider uuid, p_note text default '') returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  o public.orders; v_by text; v_rider public.profiles; v_county text; v_id bigint; n int;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null or uid is null then raise exception 'order not found' using errcode = 'P0002'; end if;
  if o.dm = 'seller_rider' and o.seller = uid then v_by := 'seller';
  elsif o.dm = 'buyer_rider' and o.buyer = uid then v_by := 'buyer';
  else raise exception 'only the person arranging the rider for this order can request one' using errcode = '42501'; end if;
  if o.status not in ('confirmed', 'dispatched') then raise exception 'a rider can be requested after the seller confirms the order' using errcode = '22023'; end if;
  if exists (select 1 from public.deliveries where order_id = o.id and status in ('requested', 'accepted', 'collected', 'in_transit')) then
    raise exception 'this order already has an active rider request' using errcode = '22023';
  end if;
  select count(*) into n from public.deliveries where (buyer = uid or seller = uid) and created_at > now() - interval '1 hour';
  if n >= 10 then raise exception 'too many rider requests, try later' using errcode = 'P0001'; end if;
  select p.* into v_rider from public.profiles p join public.riders r on r.id = p.id
   where p.id = p_rider and p.role = 'rider' and r.available and not r.suspended;
  if v_rider.id is null then raise exception 'this rider is not available' using errcode = '22023'; end if;
  if v_rider.id in (o.buyer, o.seller) then raise exception 'choose another rider' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_note, ''))) > 200 then raise exception 'note too long' using errcode = '22023'; end if;
  select county into v_county from public.profiles where id = o.seller;
  insert into public.deliveries (order_id, buyer, seller, rider, rider_name, requested_by, pickup, dropoff, items, note, history)
  values (o.id, o.buyer, o.seller, v_rider.id, v_rider.name, v_by, coalesce(v_county, ''), o.address,
          (select string_agg((e ->> 'q') || ' × ' || (e ->> 'n'), ', ') from jsonb_array_elements(o.items) e),
          btrim(coalesce(p_note, '')), public.delivery_log('requested', v_by))
  returning id into v_id;
  perform public.delivery_notify(d, 'delivery_requested', array['rider', 'buyer', 'seller']) from public.deliveries d where d.id = v_id;
  return v_id;
end;
$$;

-- Status changes. Rider: accept, decline, collect, in_transit, deliver. Requester: cancel (before collection). Admin: cancel.
create or replace function public.delivery_action(p_id bigint, p_action text, p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  d public.deliveries; v_new text; v_by text; v_req uuid;
begin
  select * into d from public.deliveries where id = p_id for update;
  if d.id is null or uid is null then raise exception 'delivery not found' using errcode = 'P0002'; end if;
  v_req := case d.requested_by when 'buyer' then d.buyer else d.seller end;
  if p_action in ('accept', 'decline', 'collect', 'in_transit', 'deliver') then
    if d.rider is distinct from uid then raise exception 'not allowed' using errcode = '42501'; end if;
    if exists (select 1 from public.riders where id = uid and suspended) and p_action = 'accept' then
      raise exception 'your rider account is suspended: contact support' using errcode = '42501';
    end if;
    v_by := 'rider';
  elsif p_action = 'cancel' then
    if uid = v_req then v_by := d.requested_by;
    elsif (select public.is_admin()) then v_by := 'admin';
    elsif uid = d.rider and d.status = 'accepted' then v_by := 'rider';
    else raise exception 'not allowed' using errcode = '42501'; end if;
  else raise exception 'unknown action' using errcode = '22023'; end if;

  if p_action = 'accept' and d.status = 'requested' then v_new := 'accepted';
  elsif p_action = 'decline' and d.status = 'requested' then v_new := 'declined';
  elsif p_action = 'collect' and d.status = 'accepted' then v_new := 'collected';
  elsif p_action = 'in_transit' and d.status in ('accepted', 'collected') then v_new := 'in_transit';
  elsif p_action = 'deliver' and d.status in ('collected', 'in_transit') then v_new := 'delivered';
  elsif p_action = 'cancel' and (d.status in ('requested', 'accepted') or (v_by = 'admin' and d.status in ('collected', 'in_transit'))) then v_new := 'cancelled';
  else raise exception 'this step is not possible now' using errcode = '22023'; end if;
  if v_by = 'admin' and char_length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'add a reason' using errcode = '22023'; end if;

  update public.deliveries set status = v_new, updated_at = now(),
         history = history || public.delivery_log(v_new, v_by, btrim(coalesce(p_note, '')))
   where id = d.id returning * into d;
  perform public.delivery_notify(d, 'delivery_' || v_new, array['buyer', 'seller', 'rider']);
end;
$$;

-- Phone numbers for the people on a delivery, once the rider has accepted.
create or replace function public.delivery_contacts(p_id bigint)
returns table (role text, name text, phone text)
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); d public.deliveries;
begin
  select * into d from public.deliveries where id = p_id;
  if d.id is null or uid is null or not (uid in (d.rider, d.buyer, d.seller) or (select public.is_admin())) then
    raise exception 'delivery not found' using errcode = 'P0002';
  end if;
  if d.status not in ('accepted', 'collected', 'in_transit', 'delivered') and not (select public.is_admin()) then
    raise exception 'contacts are shared after the rider accepts' using errcode = '22023';
  end if;
  return query
    select x.r, p.name, p.phone from (values ('buyer', d.buyer), ('seller', d.seller), ('rider', d.rider)) x(r, id)
      join public.profiles p on p.id = x.id
     where x.id is distinct from uid;
end;
$$;

-- ---------------------------------------------------------------- admin
create or replace function public.admin_rider_action(p_rider uuid, p_action text, p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (select public.is_admin()) then raise exception 'admins only' using errcode = '42501'; end if;
  if p_action = 'suspend' then
    if char_length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'add a reason' using errcode = '22023'; end if;
    update public.riders set suspended = true, available = false, admin_note = btrim(p_note), updated_at = now() where id = p_rider;
  elsif p_action = 'reinstate' then
    update public.riders set suspended = false, admin_note = btrim(coalesce(p_note, '')), updated_at = now() where id = p_rider;
  else raise exception 'unknown action' using errcode = '22023'; end if;
  if not found then raise exception 'rider not found' using errcode = 'P0002'; end if;
  perform public.verif_audit('rider_' || p_action, null, jsonb_build_object('rider', p_rider, 'note', btrim(coalesce(p_note, ''))));
end;
$$;

-- ---------------------------------------------------------------- grants
revoke all on function public.is_rider(), public.is_seller_or_rider(), public.rider_save_profile(text, text, text, text[], boolean),
  public.rider_set_available(boolean), public.available_riders(text), public.set_listing_delivery(bigint, boolean, boolean),
  public.place_orders_v2(jsonb, jsonb, text, text), public.delivery_request(text, uuid, text), public.delivery_action(bigint, text, text),
  public.delivery_contacts(bigint), public.admin_rider_action(uuid, text, text),
  public.delivery_notify(public.deliveries, text, text[]), public.delivery_log(text, text, text) from public, anon;
revoke all on function public.delivery_notify(public.deliveries, text, text[]), public.delivery_log(text, text, text) from authenticated;
grant execute on function public.is_rider(), public.is_seller_or_rider(), public.rider_save_profile(text, text, text, text[], boolean),
  public.rider_set_available(boolean), public.available_riders(text), public.set_listing_delivery(bigint, boolean, boolean),
  public.place_orders_v2(jsonb, jsonb, text, text), public.delivery_request(text, uuid, text), public.delivery_action(bigint, text, text),
  public.delivery_contacts(bigint), public.admin_rider_action(uuid, text, text) to authenticated;
