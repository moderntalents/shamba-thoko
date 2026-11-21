-- Official M-Pesa payment details for Verified Seller: Paybill 1315388, account = the seller's full name.
-- Shown on the payment screen and editable by admins. Payment submission never activates verification:
-- an admin must confirm the transaction and approve the application (unchanged rules).

insert into public.app_settings (key, value) values
  ('verification_paybill', '"1315388"'),
  ('verification_account_rule', '"Your full name (as on your ID)"')
on conflict (key) do nothing;

-- Replace the old placeholder text (only if an admin has not already changed it).
update public.app_settings
   set value = to_jsonb('Pay the verification fee by M-Pesa: Lipa na M-Pesa → Pay Bill. After paying, enter the M-Pesa confirmation code from your SMS below. Your blue tick is given only after Shamba Soko confirms the payment and approves your application.'::text),
       updated_at = now()
 where key = 'verification_payment_info'
   and value = to_jsonb('Pay KSh 500 by M-Pesa. For the payment number, call or WhatsApp Shamba Soko support on 0747 859 353. Then enter your M-Pesa confirmation code below.'::text);

drop policy if exists "verification settings are public" on public.app_settings;
create policy "verification settings are public" on public.app_settings for select to anon, authenticated
  using (key in ('verification_fee', 'verification_months', 'verification_payment_info', 'verification_paybill', 'verification_account_rule'));

create or replace function public.admin_set_payment_details(p_paybill text, p_account_rule text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_old jsonb;
begin
  perform public.require_admin();
  if coalesce(p_paybill, '') !~ '^[0-9]{5,7}$' then raise exception 'enter a valid Paybill number (5 to 7 digits)' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_account_rule, ''))) not between 3 and 80 then raise exception 'describe the account number (3 to 80 characters)' using errcode = '22023'; end if;
  select jsonb_object_agg(key, value) into v_old from public.app_settings where key in ('verification_paybill', 'verification_account_rule');
  insert into public.app_settings (key, value, updated_at) values
    ('verification_paybill', to_jsonb(p_paybill), now()), ('verification_account_rule', to_jsonb(btrim(p_account_rule)), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  -- Changes to where money is paid are recorded in the audit trail.
  perform public.verif_audit('payment_details_changed', null,
    jsonb_build_object('before', v_old, 'after', jsonb_build_object('verification_paybill', p_paybill, 'verification_account_rule', btrim(p_account_rule))));
end;
$$;
revoke all on function public.admin_set_payment_details(text, text) from public, anon;
grant execute on function public.admin_set_payment_details(text, text) to authenticated;
