-- Shamba Soko: farm marketplace.
-- Accounts (phone + password), seller listings with photos/video, orders between buyers and sellers,
-- reports and an admin role. Every rule that matters is enforced here, in the database, not in the app.
-- Payments are NOT processed: buyer and seller agree payment directly (e.g. M-Pesa) outside the app.

-- ---------------------------------------------------------------- helpers
create table public.counties (name text primary key);
insert into public.counties (name) values
('Baringo'),('Bomet'),('Bungoma'),('Busia'),('Elgeyo-Marakwet'),('Embu'),('Garissa'),('Homa Bay'),('Isiolo'),
('Kajiado'),('Kakamega'),('Kericho'),('Kiambu'),('Kilifi'),('Kirinyaga'),('Kisii'),('Kisumu'),('Kitui'),('Kwale'),
('Laikipia'),('Lamu'),('Machakos'),('Makueni'),('Mandera'),('Marsabit'),('Meru'),('Migori'),('Mombasa'),('Murang''a'),
('Nairobi'),('Nakuru'),('Nandi'),('Narok'),('Nyamira'),('Nyandarua'),('Nyeri'),('Samburu'),('Siaya'),('Taita-Taveta'),
('Tana River'),('Tharaka-Nithi'),('Trans-Nzoia'),('Turkana'),('Uasin Gishu'),('Vihiga'),('Wajir'),('West Pokot');
alter table public.counties enable row level security;
create policy "counties are public" on public.counties for select to anon, authenticated using (true);

-- ---------------------------------------------------------------- accounts
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 2 and 40),
  role text not null default 'buyer' check (role in ('buyer', 'seller')),
  biz text not null default '' check (char_length(biz) <= 40),
  phone text not null unique check (phone ~ '^254[17][0-9]{8}$'),
  county text not null references public.counties (name),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- Admins are added by the owner only (SQL / dashboard). Nobody can make themselves admin from the app.
create table public.admins (user_id uuid primary key references public.profiles (id) on delete cascade);
alter table public.admins enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins where user_id = (select auth.uid()));
$$;

create or replace function public.is_seller() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'seller');
$$;

create policy "read own profile, admins read all" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
create policy "admins see admin list" on public.admins for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- Sign-up: the app signs up with email p<phone>@phone.shambasoko.app and the details in user metadata.
-- The profile is created here, so a bad name, phone or county stops the sign-up.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_phone text := m ->> 'phone';
  v_role text := case when m ->> 'role' = 'seller' then 'seller' else 'buyer' end;
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
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.become_seller(p_biz text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if char_length(btrim(coalesce(p_biz, ''))) not between 2 and 40 then
    raise exception 'business name required' using errcode = '22023';
  end if;
  update public.profiles set role = 'seller', biz = btrim(p_biz) where id = (select auth.uid());
  if not found then raise exception 'not signed in' using errcode = '42501'; end if;
end;
$$;

-- ---------------------------------------------------------------- listings
create table public.listings (
  id bigint generated always as identity primary key,
  owner uuid not null references public.profiles (id) on delete cascade,
  seller_name text not null,
  name text not null check (char_length(name) between 2 and 40),
  category text not null check (category in ('produce', 'seedling', 'input')),
  price integer not null check (price between 1 and 1000000),
  unit text not null check (char_length(unit) between 1 and 15),
  county text not null references public.counties (name),
  chem boolean not null default false,
  photos jsonb not null default '[]'::jsonb check (jsonb_typeof(photos) = 'array' and jsonb_array_length(photos) <= 6),
  cover text,
  video text,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index listings_owner_idx on public.listings (owner);
create index listings_visible_idx on public.listings (created_at desc) where not hidden;
alter table public.listings enable row level security;

create policy "visible listings are public" on public.listings for select to anon, authenticated
  using (not hidden or owner = (select auth.uid()) or (select public.is_admin()));
create policy "sellers add their own listings" on public.listings for insert to authenticated
  with check (owner = (select auth.uid()) and (select public.is_seller()));
create policy "owners and admins remove listings" on public.listings for delete to authenticated
  using (owner = (select auth.uid()) or (select public.is_admin()));
-- No update policy: changes go through the admin functions below.

-- Fill trusted fields and check media paths on insert.
create or replace function public.listing_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p jsonb; n int;
begin
  new.owner := (select auth.uid());
  select coalesce(nullif(biz, ''), name) into new.seller_name from public.profiles where id = new.owner;
  new.hidden := false;
  new.chem := new.category = 'input';
  new.created_at := now();
  select count(*) into n from public.listings where owner = new.owner and created_at > now() - interval '1 day';
  if n >= 30 then raise exception 'too many listings today' using errcode = 'P0001'; end if;
  for p in select * from jsonb_array_elements(new.photos) loop
    if jsonb_typeof(p) <> 'object' or coalesce(p ->> 'path', '') !~ ('^' || new.owner::text || '/[A-Za-z0-9_-]{6,40}\.jpg$')
       or coalesce(p ->> 'k', '') not in ('product', 'farm', 'shop', 'stock', 'packaging', 'seller') then
      raise exception 'invalid photo' using errcode = '22023';
    end if;
  end loop;
  if new.cover is not null and not exists (select 1 from jsonb_array_elements(new.photos) e where e ->> 'path' = new.cover) then
    new.cover := new.photos -> 0 ->> 'path';
  end if;
  if new.video is not null and new.video !~ ('^' || new.owner::text || '/[A-Za-z0-9_-]{6,40}\.(mp4|webm|mov)$') then
    raise exception 'invalid video' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger listing_before_insert before insert on public.listings
  for each row execute function public.listing_before_insert();

-- Media: one public bucket. Sellers upload only into their own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-media', 'listing-media', true, 20971520,
        array['image/jpeg', 'video/mp4', 'video/webm', 'video/quicktime'])
on conflict (id) do nothing;

create policy "sellers upload to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'listing-media' and (storage.foldername(name))[1] = (select auth.uid())::text
              and (select public.is_seller()));
create policy "owners and admins delete media" on storage.objects for delete to authenticated
  using (bucket_id = 'listing-media' and ((storage.foldername(name))[1] = (select auth.uid())::text
         or (select public.is_admin())));
create policy "owners and admins list media" on storage.objects for select to authenticated
  using (bucket_id = 'listing-media' and ((storage.foldername(name))[1] = (select auth.uid())::text
         or (select public.is_admin())));

-- Contact details for a seller (shown to signed-in users only).
create or replace function public.seller_contact(p_listing bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if (select auth.uid()) is null then raise exception 'sign in required' using errcode = '42501'; end if;
  select jsonb_build_object('name', p.name, 'biz', p.biz, 'phone', p.phone) into r
    from public.listings l join public.profiles p on p.id = l.owner
   where l.id = p_listing and (not l.hidden or public.is_admin());
  return r;
end;
$$;

-- ---------------------------------------------------------------- orders
create sequence public.order_no start 1001;
create table public.orders (
  id text primary key default ('SS' || nextval('public.order_no')),
  buyer uuid references public.profiles (id) on delete set null,
  buyer_name text not null,
  buyer_phone text not null,
  seller uuid references public.profiles (id) on delete set null,
  seller_name text not null,
  items jsonb not null,
  sub integer not null,
  fee integer not null,
  dm text not null check (dm in ('boda', 'truck', 'self')),
  total integer not null,
  address text not null default '',
  status text not null default 'placed'
    check (status in ('placed', 'confirmed', 'dispatched', 'received', 'declined', 'cancelled')),
  confirmed_total integer,
  confirm_details text,
  log jsonb not null default '[]'::jsonb,
  disputes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index orders_buyer_idx on public.orders (buyer, created_at desc);
create index orders_seller_idx on public.orders (seller, created_at desc);
alter table public.orders enable row level security;
create policy "buyer, seller and admins read orders" on public.orders for select to authenticated
  using (buyer = (select auth.uid()) or seller = (select auth.uid()) or (select public.is_admin()));
-- No insert/update/delete policies: orders change only through the functions below.

create or replace function public.ms_now() returns bigint language sql stable as $$
  select (extract(epoch from now()) * 1000)::bigint;
$$;

-- Place one order per seller from the cart. Prices come from the listings, not from the app.
create or replace function public.place_orders(p_items jsonb, p_dm text, p_address text, p_phone text)
returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  me public.profiles;
  v_fee int := case p_dm when 'boda' then 150 when 'truck' then 600 when 'self' then 0 end;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[\s-]', '', 'g');
  v_addr text := btrim(coalesce(p_address, ''));
  ids text[] := '{}';
  s record; v_id text; n int;
begin
  select * into me from public.profiles where id = uid;
  if me.id is null then raise exception 'sign in required' using errcode = '42501'; end if;
  if me.role = 'seller' then raise exception 'seller accounts cannot order' using errcode = '42501'; end if;
  if v_fee is null then raise exception 'invalid delivery' using errcode = '22023'; end if;
  if v_phone ~ '^(\+?254|0)[17][0-9]{8}$' then v_phone := '254' || right(v_phone, 9);
  else raise exception 'invalid phone' using errcode = '22023'; end if;
  if p_dm = 'self' then v_addr := '';
  elsif char_length(v_addr) not between 5 and 120 then raise exception 'invalid address' using errcode = '22023'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception 'empty cart' using errcode = '22023';
  end if;
  select count(*) into n from public.orders where buyer = uid and created_at > now() - interval '1 hour';
  if n >= 20 then raise exception 'too many orders, try later' using errcode = 'P0001'; end if;

  create temp table _cart on commit drop as
    select l.id, l.owner, l.seller_name, l.name, l.price, l.unit, (e ->> 'q')::int as q
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

  for s in select owner, min(seller_name) sn, sum(price * q)::int sub,
                  jsonb_agg(jsonb_build_object('id', id, 'n', name, 'q', q, 'p', price, 'u', unit) order by id) items
             from _cart group by owner loop
    insert into public.orders (buyer, buyer_name, buyer_phone, seller, seller_name, items, sub, fee, dm, total, address, log)
    values (uid, me.name, v_phone, s.owner, s.sn, s.items, s.sub, v_fee, p_dm, s.sub + v_fee, v_addr,
            jsonb_build_array(jsonb_build_object('s', 'placed', 'at', public.ms_now(), 'by', 'b')))
    returning id into v_id;
    ids := ids || v_id;
  end loop;
  return ids;
end;
$$;

-- Buyer / seller actions on an order (the same steps as the prototype).
create or replace function public.order_action(p_id text, p_action text, p_total int default null, p_details text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  o public.orders;
  v_new text; v_by text; v_extra jsonb := '{}'::jsonb;
begin
  select * into o from public.orders where id = p_id for update;
  if o.id is null or uid is null then raise exception 'order not found' using errcode = 'P0002'; end if;
  if p_action in ('confirm', 'decline', 'dispatch', 'complete') then
    if o.seller is distinct from uid then raise exception 'not allowed' using errcode = '42501'; end if;
    v_by := 's';
  elsif p_action in ('cancel', 'receive') then
    if o.buyer is distinct from uid then raise exception 'not allowed' using errcode = '42501'; end if;
    v_by := 'b';
  else raise exception 'unknown action' using errcode = '22023'; end if;

  if p_action = 'confirm' and o.status = 'placed' then
    if p_total is null or p_total not between 1 and 10000000 then raise exception 'invalid total' using errcode = '22023'; end if;
    if char_length(btrim(coalesce(p_details, ''))) not between 5 and 200 then raise exception 'invalid details' using errcode = '22023'; end if;
    update public.orders set confirmed_total = p_total, confirm_details = btrim(p_details) where id = o.id;
    v_new := 'confirmed'; v_extra := jsonb_build_object('t', p_total);
  elsif p_action = 'decline' and o.status in ('placed', 'confirmed') then v_new := 'declined';
  elsif p_action = 'dispatch' and o.status = 'confirmed' then v_new := 'dispatched';
  elsif p_action = 'complete' and o.status in ('confirmed', 'dispatched') then v_new := 'received';
  elsif p_action = 'cancel' and o.status in ('placed', 'confirmed') then v_new := 'cancelled';
  elsif p_action = 'receive' and o.status = 'dispatched' then v_new := 'received';
  else raise exception 'this step is not possible now' using errcode = '22023'; end if;

  update public.orders
     set status = v_new,
         log = log || jsonb_build_array(jsonb_build_object('s', v_new, 'at', public.ms_now(), 'by', v_by) || v_extra)
   where id = o.id;
end;
$$;

-- ---------------------------------------------------------------- reports
create table public.reports (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('listing', 'photo', 'order')),
  ref text not null,
  name text not null,
  why text not null default '',
  photo text,
  reporter uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.reports enable row level security;
create policy "admins read reports" on public.reports for select to authenticated using ((select public.is_admin()));

create or replace function public.report_listing(p_listing bigint, p_why text default '', p_photo text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); l public.listings; n int;
begin
  if uid is null then raise exception 'sign in required' using errcode = '42501'; end if;
  select count(*) into n from public.reports where reporter = uid and created_at > now() - interval '1 day';
  if n >= 30 then raise exception 'too many reports today' using errcode = 'P0001'; end if;
  select * into l from public.listings where id = p_listing and not hidden;
  if l.id is null then raise exception 'listing not found' using errcode = 'P0002'; end if;
  if p_photo is not null and not exists (select 1 from jsonb_array_elements(l.photos) e where e ->> 'path' = p_photo) then
    raise exception 'photo not found' using errcode = 'P0002';
  end if;
  insert into public.reports (kind, ref, name, why, photo, reporter)
  values (case when p_photo is null then 'listing' else 'photo' end, l.id::text, l.name, left(coalesce(p_why, ''), 200), p_photo, uid);
end;
$$;

create or replace function public.order_dispute(p_id text, p_why text, p_note text default '')
returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); o public.orders; v_by text; at bigint := public.ms_now();
  v_why text := left(coalesce(p_why, 'Other'), 120); v_note text := left(btrim(coalesce(p_note, '')), 200);
begin
  select * into o from public.orders where id = p_id for update;
  if o.id is null or uid is null then raise exception 'order not found' using errcode = 'P0002'; end if;
  if o.buyer = uid then v_by := 'b'; elsif o.seller = uid then v_by := 's';
  else raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_array_length(o.disputes) >= 10 then raise exception 'too many reports' using errcode = 'P0001'; end if;
  update public.orders
     set disputes = disputes || jsonb_build_array(jsonb_build_object('by', v_by, 'why', v_why, 'note', v_note, 'at', at)),
         log = log || jsonb_build_array(jsonb_build_object('s', 'disputed', 'at', at, 'by', v_by))
   where id = o.id;
  insert into public.reports (kind, ref, name, why, reporter)
  values ('order', o.id, o.id, (case v_by when 'b' then 'Buyer: ' else 'Seller: ' end) || v_why
          || case when v_note <> '' then ' — ' || v_note else '' end, uid);
end;
$$;

-- ---------------------------------------------------------------- admin
create or replace function public.require_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'admins only' using errcode = '42501'; end if;
end;
$$;

create or replace function public.admin_set_hidden(p_listing bigint, p_hidden boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  update public.listings set hidden = p_hidden where id = p_listing;
end;
$$;

create or replace function public.admin_dismiss_report(p_report bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  delete from public.reports where id = p_report;
end;
$$;

-- Removes a reported photo from its listing; the app then deletes the file from storage.
create or replace function public.admin_remove_photo(p_report bigint) returns text
language plpgsql security definer set search_path = '' as $$
declare r public.reports;
begin
  perform public.require_admin();
  select * into r from public.reports where id = p_report and kind = 'photo';
  if r.id is null then raise exception 'report not found' using errcode = 'P0002'; end if;
  update public.listings
     set photos = coalesce((select jsonb_agg(e) from jsonb_array_elements(photos) e where e ->> 'path' <> r.photo), '[]'::jsonb),
         cover = case when cover = r.photo then null else cover end
   where id = r.ref::bigint;
  update public.listings set cover = photos -> 0 ->> 'path' where id = r.ref::bigint and cover is null;
  delete from public.reports where id = r.id;
  return r.photo;
end;
$$;

create or replace function public.admin_set_order_status(p_id text, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  if p_status not in ('placed', 'confirmed', 'received', 'cancelled') then raise exception 'invalid status' using errcode = '22023'; end if;
  update public.orders
     set status = p_status,
         log = log || jsonb_build_array(jsonb_build_object('s', 'adm', 'at', public.ms_now(), 'by', 'a', 'to', p_status))
   where id = p_id and status <> p_status;
end;
$$;

-- ---------------------------------------------------------------- account deletion
-- The app first deletes the user's media files, then calls this. Listings go with the account;
-- orders stay for the other party with the buyer's details removed.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in required' using errcode = '42501'; end if;
  update public.orders set buyer_name = 'Deleted account', buyer_phone = '', address = '' where buyer = uid;
  delete from auth.users where id = uid;
end;
$$;

-- ---------------------------------------------------------------- grants
revoke all on function public.handle_new_user(), public.listing_before_insert(), public.require_admin() from public, anon, authenticated;
revoke all on function public.become_seller(text), public.seller_contact(bigint), public.place_orders(jsonb, text, text, text),
  public.order_action(text, text, int, text), public.report_listing(bigint, text, text), public.order_dispute(text, text, text),
  public.admin_set_hidden(bigint, boolean), public.admin_dismiss_report(bigint), public.admin_remove_photo(bigint),
  public.admin_set_order_status(text, text), public.delete_my_account() from public, anon;
grant execute on function public.become_seller(text), public.seller_contact(bigint), public.place_orders(jsonb, text, text, text),
  public.order_action(text, text, int, text), public.report_listing(bigint, text, text), public.order_dispute(text, text, text),
  public.admin_set_hidden(bigint, boolean), public.admin_dismiss_report(bigint), public.admin_remove_photo(bigint),
  public.admin_set_order_status(text, text), public.delete_my_account() to authenticated;

revoke all on public.profiles, public.admins, public.listings, public.orders, public.reports from anon;
revoke insert, update, delete on public.profiles, public.admins, public.orders, public.reports from authenticated;
revoke update on public.listings from authenticated;
grant select on public.listings, public.counties to anon;
grant select on public.counties to authenticated;
grant select, insert, delete on public.listings to authenticated;
grant select on public.profiles, public.admins, public.orders, public.reports to authenticated;

-- Sellers see new orders without refreshing.
alter publication supabase_realtime add table public.orders;
