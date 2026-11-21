-- Daily automatic retention. Runs at 03:20 Nairobi time (00:20 UTC).
-- 1. In the database: apply the retention rules (works even if the Edge Function is unavailable).
-- 2. Edge Function verification-retention: securely deletes the queued photo files via the Storage API.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Shared secret between the scheduled job and the Edge Function, kept in the encrypted vault.
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'verification_retention_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'verification_retention_secret',
                                'Shared secret for the verification-retention Edge Function');
  end if;
end $$;

create or replace function public.verification_cron_secret_ok(p_secret text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(length(p_secret) = 64 and p_secret = (select decrypted_secret from vault.decrypted_secrets
                                                         where name = 'verification_retention_secret'), false);
$$;
revoke all on function public.verification_cron_secret_ok(text) from public, anon, authenticated;
grant execute on function public.verification_cron_secret_ok(text) to service_role;

select cron.unschedule(jobid) from cron.job where jobname in ('verification-retention-db', 'verification-retention-files');
select cron.schedule('verification-retention-db', '20 0 * * *', $$ select public.verification_retention_run(); $$);
select cron.schedule('verification-retention-files', '25 0 * * *', $$
  select net.http_post(
    url := 'https://nskbksmguplcdchbbxje.supabase.co/functions/v1/verification-retention',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-retention-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'verification_retention_secret')),
    body := '{}'::jsonb);
$$);
