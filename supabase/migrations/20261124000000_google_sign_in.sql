-- Google sign-in alongside phone-number accounts.
-- Phone accounts are unchanged (their profile is still created at sign-up from the phone metadata).
-- A Google sign-up creates only the auth user; the person then completes their Shamba Soko profile
-- (name, phone, county and role) with complete_my_profile() before they can buy, sell or ride.
-- Existing phone users can connect Google from their account (Supabase identity linking), so they
-- keep one account and can sign in either way.

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_provider text := coalesce(new.raw_app_meta_data ->> 'provider', 'email');
  v_phone text := m ->> 'phone';
  v_role text := case when m ->> 'role' in ('seller', 'rider') then m ->> 'role' else 'buyer' end;
  v_name text := regexp_replace(btrim(coalesce(m ->> 'name', '')), '\s+', ' ', 'g');
  v_biz text := btrim(coalesce(m ->> 'biz', ''));
begin
  -- Google (and any other OAuth provider): no profile yet; the person completes it in the app.
  -- raw_app_meta_data is set by Supabase Auth, never by the client.
  if v_provider <> 'email' then
    return new;
  end if;
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

-- Finish a Google sign-up: create the profile for the signed-in user (once).
create or replace function public.complete_my_profile(p_name text, p_phone text, p_county text, p_role text, p_biz text default '')
returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[\s-]', '', 'g');
  v_role text := coalesce(p_role, 'buyer');
  v_biz text := btrim(coalesce(p_biz, ''));
begin
  if uid is null then raise exception 'sign in required' using errcode = '42501'; end if;
  if exists (select 1 from public.profiles where id = uid) then
    raise exception 'your profile is already complete' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = uid and coalesce(u.raw_app_meta_data ->> 'provider', 'email') <> 'email') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if char_length(v_name) not between 2 and 40 then raise exception 'enter your name (2 to 40 characters)' using errcode = '22023'; end if;
  if v_phone ~ '^(\+?254|0)[17][0-9]{8}$' then v_phone := '254' || right(v_phone, 9);
  else raise exception 'invalid phone' using errcode = '22023'; end if;
  if v_role not in ('buyer', 'seller', 'rider') then raise exception 'choose buyer, seller or rider' using errcode = '22023'; end if;
  if v_role = 'seller' and char_length(v_biz) not between 2 and 40 then raise exception 'business name required' using errcode = '22023'; end if;
  if not exists (select 1 from public.counties where name = p_county) then raise exception 'choose your county' using errcode = '22023'; end if;
  if exists (select 1 from public.profiles where phone = v_phone) then
    raise exception 'this phone number already has an account: log in with your phone and password, then connect Google in Account'
      using errcode = '23505';
  end if;
  insert into public.profiles (id, name, role, biz, phone, county)
  values (uid, v_name, v_role, case when v_role = 'seller' then v_biz else '' end, v_phone, p_county);
  if v_role = 'rider' then
    insert into public.riders (id, areas) values (uid, array[p_county]);
  end if;
end;
$$;

revoke all on function public.complete_my_profile(text, text, text, text, text) from public, anon;
grant execute on function public.complete_my_profile(text, text, text, text, text) to authenticated;
