-- The nightly database job also expires finished promotions and cancels approvals left unpaid for 14 days.
select cron.unschedule(jobid) from cron.job where jobname = 'verification-retention-db';
select cron.schedule('verification-retention-db', '20 0 * * *',
  $$ select public.verification_lifecycle_run(); select public.promo_lifecycle_run(); select public.verification_retention_run(); $$);
