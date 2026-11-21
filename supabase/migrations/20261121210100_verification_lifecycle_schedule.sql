-- The nightly database job now runs the lifecycle (reminders, automatic closure) before the retention rules.
select cron.unschedule(jobid) from cron.job where jobname = 'verification-retention-db';
select cron.schedule('verification-retention-db', '20 0 * * *',
  $$ select public.verification_lifecycle_run(); select public.verification_retention_run(); $$);
