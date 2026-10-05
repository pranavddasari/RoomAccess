begin;
-- Server-only deletion queue. Claiming a path prevents late attachment/upload.
create table public.photo_cleanup_queue (
 storage_path text primary key, reason text not null, claimed_at timestamptz not null default now(), deleted_at timestamptz
);
alter table public.photo_cleanup_queue enable row level security;
revoke all on public.photo_cleanup_queue from public,anon,authenticated;
create function public.retention_plan(p_dry_run boolean default true) returns jsonb language plpgsql security definer set search_path='' as $$
declare paths jsonb;
begin
 perform private.lock_memberships();
 select coalesce(jsonb_agg(c),'[]'::jsonb) into paths from (
 select storage_path,reason from (
 select p.storage_path,'EXPIRED_SESSION'::text reason from public.session_photos p join public.sessions s on s.id=p.session_id
 where s.status<>'ACTIVE' and s.closed_at<now()-interval '30 days'
 union
 select o.name,'ORPHAN'::text from storage.objects o where o.bucket_id='session-photos' and o.created_at<now()-interval '24 hours'
 and not exists(select 1 from public.session_photos p where p.storage_path=o.name)
 union
 select u.storage_path,'ABANDONED_UPLOAD'::text from public.photo_uploads u where u.expires_at<now() and u.deleted_at is null
 and not exists(select 1 from public.session_photos p where p.storage_path=u.storage_path)
 and not exists(select 1 from storage.objects o where o.bucket_id='session-photos' and o.name=u.storage_path and o.created_at>=now()-interval '24 hours')
 union
 select q.storage_path,q.reason from public.photo_cleanup_queue q where q.deleted_at is null
 ) candidate where not exists(select 1 from public.photo_cleanup_queue q where q.storage_path=candidate.storage_path and q.deleted_at is not null)
 order by storage_path limit 200
 ) c;
 if not p_dry_run then
 insert into public.photo_cleanup_queue(storage_path,reason) select x.storage_path,x.reason from jsonb_to_recordset(paths) as x(storage_path text,reason text) on conflict(storage_path) do nothing;
 update public.photo_uploads u set deleting=true where exists(select 1 from public.photo_cleanup_queue q where q.storage_path=u.storage_path);
 end if;
 return jsonb_build_object('paths',paths,'expiredSessions',(select count(*) from public.sessions where status<>'ACTIVE' and closed_at<now()-interval '30 days'),
 'expiredCustody',(select count(*) from public.key_custody_events where created_at<now()-interval '30 days' and (session_id is null or not exists(select 1 from public.sessions s where s.id=session_id and s.status='ACTIVE'))));
end; $$;
create function public.retention_ack(p_paths text[]) returns void language plpgsql security definer set search_path='' as $$
begin
 perform private.lock_memberships();
 update public.photo_cleanup_queue set deleted_at=coalesce(deleted_at,now()) where storage_path=any(p_paths);
 update public.photo_uploads u set deleted_at=now() where u.storage_path=any(p_paths) and exists(select 1 from public.photo_cleanup_queue q where q.storage_path=u.storage_path and q.deleted_at is not null);
end; $$;
create function public.retention_finalize() returns jsonb language plpgsql security definer set search_path='' as $$
declare session_count integer; custody_count integer; flag_count integer; audit_count integer; operation_count integer;
begin
 perform private.lock_memberships(); perform set_config('app.retention_cleanup','true',true);
 delete from public.sessions s where s.status<>'ACTIVE' and s.closed_at<now()-interval '30 days'
 and not exists(select 1 from public.session_photos p where p.session_id=s.id and not exists(select 1 from public.photo_cleanup_queue q where q.storage_path=p.storage_path and q.deleted_at is not null));
 get diagnostics session_count=row_count;
 -- Keep facts tied to retained sessions (especially ACTIVE sessions regardless of age).
 delete from public.key_custody_events e where e.created_at<now()-interval '30 days' and e.session_id is null; get diagnostics custody_count=row_count;
 delete from public.flags f where f.created_at<now()-interval '30 days' and f.session_id is null
 and (f.custody_event_id is null or not exists(select 1 from public.key_custody_events e where e.id=f.custody_event_id)); get diagnostics flag_count=row_count;
 delete from public.operational_audit where created_at<now()-interval '30 days' and session_id is null and custody_event_id is null; get diagnostics audit_count=row_count;
 delete from public.processed_operations where created_at<now()-interval '30 days' and session_id is null; get diagnostics operation_count=row_count;
 delete from public.photo_uploads u where u.deleted_at<now()-interval '30 days' and not exists(select 1 from public.session_photos p where p.id=u.id);
 delete from public.photo_cleanup_queue where deleted_at<now()-interval '30 days';
 perform set_config('app.retention_cleanup','false',true);
 return jsonb_build_object('sessions',session_count,'custody',custody_count,'flags',flag_count,'audit',audit_count,'operations',operation_count);
end; $$;
revoke all on function public.retention_plan(boolean),public.retention_ack(text[]),public.retention_finalize() from public,anon,authenticated;
grant execute on function public.retention_plan(boolean),public.retention_ack(text[]),public.retention_finalize() to service_role;
commit;
