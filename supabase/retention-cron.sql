-- Run manually AFTER deploying retention-cleanup and creating the two Vault secrets
-- music_retention_url and music_retention_secret. Never paste secret values here.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if coalesce(current_setting('cron.timezone',true),'GMT') not in ('GMT','UTC','Etc/UTC') then
 raise exception 'Expected UTC/GMT cron timezone. Convert the schedule for the actual cron.timezone before registering the job.';
 end if;
 if not exists(select 1 from vault.decrypted_secrets where name='music_retention_url') or
 not exists(select 1 from vault.decrypted_secrets where name='music_retention_secret') then raise exception 'Create both required Vault secrets first.'; end if;
end; $$;
-- 18:35 UTC = 00:05 Asia/Kolkata on the following local calendar day.
select cron.schedule('music-room-retention','35 18 * * *', $job$
 select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name='music_retention_url'),
  headers := jsonb_build_object('Content-Type','application/json','x-retention-secret',(select decrypted_secret from vault.decrypted_secrets where name='music_retention_secret')),
  body := '{"dryRun":false}'::jsonb,
  timeout_milliseconds := 180000
 );
$job$);
