-- Verified Seller lifecycle: applications waiting for the seller ("More information needed") close automatically
-- after 90 days without a response, with reminders 30 and 7 days before, and an in-app notification on closure.
-- After closure the seller may apply again (unless suspended, within the revocation wait, or blocked).

alter table public.seller_verifications drop constraint if exists seller_verifications_status_check;
alter table public.seller_verifications add constraint seller_verifications_status_check
  check (status in ('pending', 'info_requested', 'approved', 'rejected', 'suspended', 'revoked', 'withdrawn', 'superseded', 'closed'));

alter table public.seller_verifications
  add column if not exists info_requested_at timestamptz,   -- start of the 90-day response window
  add column if not exists reminded_30_at timestamptz,
  add column if not exists reminded_7_at timestamptz,
  add column if not exists consent_version text not null default '2026-11-21';
update public.seller_verifications set info_requested_at = coalesce(info_requested_at, updated_at) where status = 'info_requested';

-- Start (or restart) the response window whenever an application enters "More information needed".
create or replace function public.verif_info_window() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'info_requested' and (tg_op = 'INSERT' or old.status is distinct from 'info_requested') then
    new.info_requested_at := now(); new.reminded_30_at := null; new.reminded_7_at := null;
  end if;
  return new;
end;
$$;
drop trigger if exists verif_info_window on public.seller_verifications;
create trigger verif_info_window before insert or update of status on public.seller_verifications
  for each row execute function public.verif_info_window();

-- ---------------------------------------------------------------- in-app notifications
create table public.seller_notifications (
  id bigint generated always as identity primary key,
  seller uuid not null references public.profiles (id) on delete cascade,
  application_id bigint references public.seller_verifications (id) on delete set null,
  kind text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (application_id, kind)          -- each reminder or closure notice is sent once per application
);
create index seller_notifications_seller_idx on public.seller_notifications (seller, created_at desc);
alter table public.seller_notifications enable row level security;
create policy "sellers read own notifications" on public.seller_notifications for select to authenticated
  using (seller = (select auth.uid()));
revoke all on public.seller_notifications from anon, authenticated;
grant select on public.seller_notifications to authenticated;

create or replace function public.mark_notifications_read() returns void
language sql security definer set search_path = '' as $$
  update public.seller_notifications set read_at = now() where seller = (select auth.uid()) and read_at is null;
$$;
revoke all on function public.mark_notifications_read() from public, anon;
grant execute on function public.mark_notifications_read() to authenticated;

-- ---------------------------------------------------------------- nightly lifecycle job
create or replace function public.verification_lifecycle_run() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; n30 int := 0; n7 int := 0; nclosed int := 0;
begin
  perform public.verif_require_system_or_admin();
  -- Reminder 30 days before closure (day 60) and 7 days before (day 83). Sent once each.
  for r in select id, seller from public.seller_verifications
            where status = 'info_requested' and seller is not null and reminded_30_at is null
              and info_requested_at <= now() - interval '60 days' and info_requested_at > now() - interval '90 days' loop
    insert into public.seller_notifications (seller, application_id, kind) values (r.seller, r.id, 'verif_reminder_30') on conflict do nothing;
    update public.seller_verifications set reminded_30_at = now() where id = r.id;
    perform public.verif_audit('reminder_30_days', r.id, '{}'::jsonb, 'system'); n30 := n30 + 1;
  end loop;
  for r in select id, seller from public.seller_verifications
            where status = 'info_requested' and seller is not null and reminded_7_at is null
              and info_requested_at <= now() - interval '83 days' and info_requested_at > now() - interval '90 days' loop
    insert into public.seller_notifications (seller, application_id, kind) values (r.seller, r.id, 'verif_reminder_7') on conflict do nothing;
    update public.seller_verifications set reminded_7_at = now() where id = r.id;
    perform public.verif_audit('reminder_7_days', r.id, '{}'::jsonb, 'system'); n7 := n7 + 1;
  end loop;
  -- Close after 90 days without a response (not if on legal hold).
  for r in select v.id, v.seller from public.seller_verifications v
             left join public.verification_cases c on c.application_id = v.id
            where v.status = 'info_requested' and v.info_requested_at <= now() - interval '90 days'
              and not coalesce(c.legal_hold, false) loop
    update public.seller_verifications
       set status = 'closed', closed_at = now(), updated_at = now(),
           admin_note = 'Closed automatically: no response within 90 days. You can send a new application.',
           history = history || jsonb_build_array(jsonb_build_object('s', 'closed', 'by', 'system', 'at', public.ms_now(),
                                                                     'note', 'No response within 90 days'))
     where id = r.id;
    if r.seller is not null then
      insert into public.seller_notifications (seller, application_id, kind) values (r.seller, r.id, 'verif_closed') on conflict do nothing;
    end if;
    perform public.verif_audit('auto_closed', r.id, jsonb_build_object('rule', 'no_response_90_days'), 'system'); nclosed := nclosed + 1;
  end loop;
  return jsonb_build_object('reminders_30', n30, 'reminders_7', n7, 'closed', nclosed);
end;
$$;
revoke all on function public.verification_lifecycle_run() from public, anon;
grant execute on function public.verification_lifecycle_run() to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.verification_lifecycle_run() to service_role;
  end if;
end $$;
