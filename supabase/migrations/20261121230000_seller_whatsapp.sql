-- Optional WhatsApp contact for Verified Sellers.
-- The seller must enter a WhatsApp number AND choose to show it. It is shown only while the seller is verified
-- (approved, paid, not expired). Only the seller id and WhatsApp number are ever public — never ID or documents.

alter table public.profiles
  add column if not exists whatsapp text check (whatsapp is null or whatsapp ~ '^254[17][0-9]{8}$'),
  add column if not exists whatsapp_public boolean not null default false;
alter table public.profiles drop constraint if exists profiles_whatsapp_public_needs_number;
alter table public.profiles add constraint profiles_whatsapp_public_needs_number check (not whatsapp_public or whatsapp is not null);

-- The seller sets (or clears) their WhatsApp number and visibility. Profiles have no update policy, so this is the only way.
create or replace function public.set_my_whatsapp(p_number text, p_public boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); v text := regexp_replace(coalesce(p_number, ''), '[\s()+-]', '', 'g');
begin
  if not exists (select 1 from public.profiles where id = uid and role = 'seller') then
    raise exception 'seller account required' using errcode = '42501';
  end if;
  if v = '' then
    update public.profiles set whatsapp = null, whatsapp_public = false where id = uid;
    return;
  end if;
  if v ~ '^(254|0)[17][0-9]{8}$' then v := '254' || right(v, 9);
  else raise exception 'enter a valid Kenyan WhatsApp number, e.g. 0712345678' using errcode = '22023'; end if;
  update public.profiles set whatsapp = v, whatsapp_public = coalesce(p_public, false) where id = uid;
end;
$$;
revoke all on function public.set_my_whatsapp(text, boolean) from public, anon;
grant execute on function public.set_my_whatsapp(text, boolean) to authenticated;

-- Public list used for the WhatsApp buttons: verified sellers who opted in. Nothing else is returned.
create or replace function public.seller_whatsapp() returns table (seller uuid, whatsapp text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.whatsapp
    from public.profiles p
    join public.verified_sellers() v on v.seller = p.id
   where p.role = 'seller' and p.whatsapp is not null and p.whatsapp_public;
$$;
revoke all on function public.seller_whatsapp() from public;
grant execute on function public.seller_whatsapp() to anon, authenticated;
