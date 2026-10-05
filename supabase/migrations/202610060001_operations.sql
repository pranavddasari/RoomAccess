begin;
create table public.rooms (
 id uuid primary key default gen_random_uuid(), display_name text not null unique,
 active boolean not null default true, version bigint not null default 0,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
insert into public.rooms(display_name) values ('MR-1'),('MR-2'),('MR-3'),('MR-4'),('MR-5');
-- Absence means uninitialized. No physical holder is assumed by the seed.
create table public.room_key_state (
 room_id uuid primary key references public.rooms(id), holder_type text not null check(holder_type in ('MEMBER','SW','MHO')),
 holder_member_id uuid references public.club_members(id), updated_at timestamptz not null default now(),
 updated_by uuid not null references public.club_members(id), version bigint not null,
 check((holder_type='MEMBER') = (holder_member_id is not null))
);
create table public.sessions (
 id uuid primary key, room_id uuid not null references public.rooms(id), member_id uuid not null references public.club_members(id),
 status text not null check(status in ('ACTIVE','COMPLETE','INCOMPLETE')), started_at timestamptz not null default now(),
 closed_at timestamptz, closure_reason text, closed_by uuid references public.club_members(id),
 recovery_reason text check(recovery_reason in ('PREVIOUS_BAND_LEFT','RECEIVED_KEY_FROM_PREVIOUS_USER','RECEIVED_KEY_FROM_SW','RECEIVED_KEY_FROM_MHO','OTHER')),
 recovery_remarks text check(length(recovery_remarks)<=500), key_disposition jsonb,
 created_at timestamptz not null default now(), version bigint not null default 0,
 check((status='ACTIVE' and closed_at is null and closure_reason is null and closed_by is null) or
       (status<>'ACTIVE' and closed_at is not null and closure_reason is not null and closed_by is not null)),
 check(recovery_reason is distinct from 'OTHER' or length(btrim(recovery_remarks))>0)
);
create unique index one_active_session_per_room on public.sessions(room_id) where status='ACTIVE';
create index sessions_member_started on public.sessions(member_id,started_at desc);
create index sessions_closed on public.sessions(closed_at) where status<>'ACTIVE';
create index sessions_room_started on public.sessions(room_id,started_at desc);
-- Upload intents precede Storage uploads. Unique paths are never overwritten.
create table public.photo_uploads (
 id uuid primary key, session_id uuid not null, auth_user_id uuid not null references auth.users(id),
 stage text not null check(stage in ('START','END')), category text not null check(category in ('ROOM','CABLES')),
 storage_path text not null unique, created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '24 hours', deleting boolean not null default false,
 deleted_at timestamptz
);
create table public.session_photos (
 id uuid primary key references public.photo_uploads(id), session_id uuid not null references public.sessions(id) on delete cascade,
 stage text not null check(stage in ('START','END')), category text not null check(category in ('ROOM','CABLES')),
 storage_path text not null unique, mime_type text not null check(mime_type='image/jpeg'),
 byte_size bigint not null check(byte_size between 1 and 512000), width integer check(width between 1 and 1600), height integer check(height between 1 and 1600),
 uploaded_by uuid not null references public.club_members(id), uploaded_at timestamptz not null default now(),
 unique(session_id,stage,category)
);
create table public.key_custody_events (
 id uuid primary key default gen_random_uuid(), room_id uuid not null references public.rooms(id),
 previous_recorded_holder jsonb, reported_source jsonb, new_holder jsonb not null,
 mode text not null check(mode in ('INCOMING','OUTGOING','SESSION_CHECKOUT','ADMIN_CORRECTION')),
 actor_id uuid not null references public.club_members(id), session_id uuid references public.sessions(id) on delete cascade,
 mismatch boolean not null default false, reason text, created_at timestamptz not null default now(), operation_id uuid not null
);
create index custody_room_created on public.key_custody_events(room_id,created_at desc);
create table public.flags (
 id uuid primary key default gen_random_uuid(), room_id uuid not null references public.rooms(id),
 type text not null check(type in ('MISSING_END_CHECKOUT','KEY_CUSTODY_MISMATCH')),
 subject_member_id uuid references public.club_members(id), session_id uuid references public.sessions(id) on delete cascade,
 custody_event_id uuid references public.key_custody_events(id) on delete cascade,
 status text not null default 'OPEN' check(status in ('OPEN','RESOLVED')), created_at timestamptz not null default now(),
 resolved_at timestamptz, resolved_by uuid references public.club_members(id), resolution_note text,
 check((status='OPEN' and resolved_at is null and resolved_by is null) or (status='RESOLVED' and resolved_at is not null and resolved_by is not null))
);
create index flags_status_created on public.flags(status,created_at desc);
create index flags_room on public.flags(room_id);
create index flags_subject on public.flags(subject_member_id);
create table public.operational_audit (
 id uuid primary key default gen_random_uuid(), actor_id uuid not null references public.club_members(id),
 room_id uuid not null references public.rooms(id), session_id uuid references public.sessions(id) on delete cascade,
 custody_event_id uuid references public.key_custody_events(id) on delete cascade,
 event text not null check(event in ('SESSION_STARTED','SESSION_CLOSED','KEY_CUSTODY_RECORDED','FLAG_RESOLVED','ADMIN_CORRECTION')),
 operation_id uuid not null, created_at timestamptz not null default now(), details jsonb not null default '{}'
);
create table public.processed_operations (
 operation_id uuid primary key, actor_id uuid not null references public.club_members(id), request jsonb not null,
 session_id uuid references public.sessions(id) on delete cascade, result jsonb not null, created_at timestamptz not null default now()
);
create function private.active_member() returns uuid language sql stable security definer set search_path='' as $$
 select id from public.club_members where auth_user_id=auth.uid() and email=private.verified_google_email() and status='ACTIVE';
$$;
create function public.operational_directory() returns table(id uuid,name text) language sql stable security definer set search_path='' as $$
 select id,name from public.club_members where private.active_member() is not null order by name;
$$;
create function private.check_disable_custody() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform private.lock_memberships();
 if old.status='ACTIVE' and new.status='DISABLED' and
 (exists(select 1 from public.room_key_state where holder_member_id=old.id) or exists(select 1 from public.sessions where member_id=old.id and status='ACTIVE')) then
 raise exception 'Resolve this member''s active room sessions and key custody before disabling them.';
 end if; return new;
end; $$;
create trigger a_operational_disable_guard before update on public.club_members for each row execute function private.check_disable_custody();
create function private.freeze_terminal_session() returns trigger language plpgsql set search_path='' as $$
begin
 if old.status<>'ACTIVE' then raise exception 'Terminal sessions cannot be changed.'; end if;
 if new.member_id<>old.member_id or new.room_id<>old.room_id or new.id<>old.id or new.started_at<>old.started_at then raise exception 'Session identity is immutable.'; end if;
 return new;
end; $$;
create trigger freeze_session before update on public.sessions for each row execute function private.freeze_terminal_session();
create function private.freeze_evidence() returns trigger language plpgsql set search_path='' as $$
declare sid uuid;
begin
 sid=case when TG_OP='DELETE' then old.session_id else new.session_id end;
 if exists(select 1 from public.sessions where id=sid and status<>'ACTIVE') then
 -- Only the server cleanup role may remove expired evidence; no updates even then.
 if TG_OP<>'DELETE' or coalesce(current_setting('app.retention_cleanup',true),'')<>'true' then raise exception 'Terminal evidence cannot be changed.'; end if;
 end if;
 return case when TG_OP='DELETE' then old else new end;
end; $$;
create trigger freeze_photo before insert or update or delete on public.session_photos for each row execute function private.freeze_evidence();
create function private.holder(p_type text,p_member uuid) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('type',case when p_type='MEMBER' then 'member' else 'location' end,'id',case when p_type='MEMBER' then p_member::text else lower(p_type) end);
$$;
create function private.valid_holder(p_holder jsonb,p_actor uuid,p_no_self boolean default true) returns void language plpgsql security definer set search_path='' as $$
begin
 if p_holder->>'type'='member' then
 if not exists(select 1 from public.club_members where id=(p_holder->>'id')::uuid and status='ACTIVE') then raise exception 'Choose an active club member.'; end if;
 if p_no_self and (p_holder->>'id')::uuid=p_actor then raise exception 'You cannot transfer a key to yourself.'; end if;
 elsif p_holder->>'type'='location' and p_holder->>'id' in ('sw','mho') then null;
 else raise exception 'Choose a valid key holder.'; end if;
end; $$;
create function public.register_photo_upload(p_id uuid,p_session_id uuid,p_stage text,p_category text) returns text language plpgsql security definer set search_path='' as $$
declare a uuid; path text; u public.photo_uploads;
begin
 perform private.lock_memberships(); a=private.active_member(); if a is null then raise exception 'Active membership required.'; end if;
 if p_stage not in ('START','END') or p_category not in ('ROOM','CABLES') then raise exception 'Invalid photo context.'; end if;
 if p_stage='START' and exists(select 1 from public.sessions where id=p_session_id) then raise exception 'Start evidence is already committed.'; end if;
 if p_stage='END' and not exists(select 1 from public.sessions where id=p_session_id and member_id=a and status='ACTIVE') then raise exception 'Only the active session owner can add end evidence.'; end if;
 path=auth.uid()::text||'/'||p_session_id::text||'/'||p_stage||'/'||p_category||'-'||p_id::text||'.jpg';
 select * into u from public.photo_uploads where id=p_id;
 if found then
 if u.storage_path<>path or u.deleting or u.expires_at<=now() then raise exception 'Photo draft expired or conflicts. Retake the photo.'; end if;
 return path; end if;
 insert into public.photo_uploads(id,session_id,auth_user_id,stage,category,storage_path) values(p_id,p_session_id,auth.uid(),p_stage,p_category,path);
 return path;
end; $$;
create function private.attach_photo(p_photo uuid,p_session uuid,p_stage text,p_category text,p_actor uuid,p_dimensions jsonb) returns void language plpgsql security definer set search_path='' as $$
declare u public.photo_uploads; o storage.objects; old_photo uuid;
begin
 select * into u from public.photo_uploads where id=p_photo for update;
 if not found or u.deleting or u.expires_at<=now() or u.auth_user_id<>auth.uid() or u.session_id<>p_session or u.stage<>p_stage or u.category<>p_category then raise exception 'Invalid or expired photo draft.'; end if;
 select * into o from storage.objects where bucket_id='session-photos' and name=u.storage_path;
 if not found or o.owner_id is distinct from auth.uid()::text or coalesce((o.metadata->>'size')::bigint,0) not between 1 and 512000 or o.metadata->>'mimetype' is distinct from 'image/jpeg' then raise exception 'A valid private uploaded photo is required.'; end if;
 -- Replacing an ACTIVE slot detaches the old unique object; cleanup removes it later.
 select id into old_photo from public.session_photos where session_id=p_session and stage=p_stage and category=p_category;
 if old_photo=p_photo then return; end if;
 delete from public.session_photos where session_id=p_session and stage=p_stage and category=p_category;
 insert into public.session_photos(id,session_id,stage,category,storage_path,mime_type,byte_size,width,height,uploaded_by)
 values(p_photo,p_session,p_stage,p_category,u.storage_path,'image/jpeg',(o.metadata->>'size')::bigint,(p_dimensions->>'width')::integer,(p_dimensions->>'height')::integer,p_actor);
end; $$;
-- A single small command surface centralizes locking, live authorization and retries.
create function public.operational_command(p_operation_id uuid,p_action text,p_room_id uuid,p_expected_version bigint,p_session_id uuid default null,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare a uuid; r public.rooms; k public.room_key_state; s public.sessions; prior public.processed_operations;
 req jsonb; result jsonb; destination jsonb; previous jsonb; event_id uuid; flag_row public.flags; reason text;
begin
 perform private.lock_memberships(); a=private.active_member(); if a is null then raise exception 'Active membership required.'; end if;
 req=jsonb_build_object('action',p_action,'room',p_room_id,'version',p_expected_version,'session',p_session_id,'payload',p_payload);
 select * into prior from public.processed_operations where operation_id=p_operation_id;
 if found then
 if prior.actor_id<>a or prior.request<>req then raise exception 'Operation ID conflicts with another command.'; end if;
 return prior.result; end if;
 select * into r from public.rooms where id=p_room_id and active for update;
 if not found then raise exception 'Room not found or inactive.'; end if;
 if p_action<>'RESOLVE_FLAG' and (p_expected_version is null or r.version<>p_expected_version) then raise exception 'Room state changed. Refresh and review before retrying.'; end if;
 select * into k from public.room_key_state where room_id=r.id for update;
 previous=case when k.room_id is null then null else private.holder(k.holder_type,k.holder_member_id) end;
 select * into s from public.sessions where room_id=r.id and status='ACTIVE' for update;
 if p_action in ('TRANSFER','RECEIVE','CORRECT') and p_session_id is not null and p_session_id is distinct from s.id then raise exception 'The active session changed. Refresh and review.'; end if;
 if p_action in ('END','END_PHOTO','SELF_RECOVER') and (s.id is null or s.id is distinct from p_session_id or s.member_id<>a) then raise exception 'Only the exact active session owner can do this.'; end if;
 if p_action='START' then
 if k.room_id is null then raise exception 'Key status not initialized. Contact an administrator.'; end if;
 if k.holder_type<>'MEMBER' or k.holder_member_id<>a then raise exception 'You must hold this room key to start.'; end if;
 if s.id is not null then raise exception 'This room already has an active session.'; end if;
 if p_session_id is null then raise exception 'Session ID required.'; end if;
 insert into public.sessions(id,room_id,member_id,status) values(p_session_id,r.id,a,'ACTIVE');
 perform private.attach_photo((p_payload->'roomPhoto'->>'id')::uuid,p_session_id,'START','ROOM',a,p_payload->'roomPhoto');
 perform private.attach_photo((p_payload->'cablesPhoto'->>'id')::uuid,p_session_id,'START','CABLES',a,p_payload->'cablesPhoto');
 insert into public.operational_audit(actor_id,room_id,session_id,event,operation_id) values(a,r.id,p_session_id,'SESSION_STARTED',p_operation_id);
 elsif p_action='END_PHOTO' then
 perform private.attach_photo((p_payload->>'id')::uuid,s.id,'END',p_payload->>'category',a,p_payload);
 update public.sessions set version=version+1 where id=s.id;
 elsif p_action in ('END','SELF_RECOVER') then
 if k.holder_type is distinct from 'MEMBER' or k.holder_member_id is distinct from a then raise exception 'You must hold this room key.'; end if;
 if p_action='END' then
 if (select count(*) from public.session_photos where session_id=s.id and stage='END')<>2 then raise exception 'Both accepted end photos are required.'; end if;
 destination=p_payload->'destination';
 if destination->>'type'='retain' then destination=private.holder('MEMBER',a);
 else perform private.valid_holder(destination,a); end if;
 reason='NORMAL_CHECKOUT';
 else destination=previous; reason='MISSED_CHECKOUT_SELF_REPORTED'; end if;
 update public.sessions set status=case when p_action='END' then 'COMPLETE' else 'INCOMPLETE' end,closed_at=now(),closed_by=a,closure_reason=reason,
 key_disposition=case when p_action='END' then p_payload->'destination' else null end,version=version+1 where id=s.id;
 insert into public.operational_audit(actor_id,room_id,session_id,event,operation_id,details) values(a,r.id,s.id,'SESSION_CLOSED',p_operation_id,jsonb_build_object('reason',reason,'outcome',case when p_action='END' then 'COMPLETE' else 'INCOMPLETE' end,'keyDisposition',p_payload->'destination'));
 if p_action='SELF_RECOVER' then insert into public.flags(room_id,type,subject_member_id,session_id) values(r.id,'MISSING_END_CHECKOUT',s.member_id,s.id); end if;
 if p_action='END' and p_payload->'destination'->>'type'<>'retain' then
 insert into public.key_custody_events(room_id,previous_recorded_holder,new_holder,mode,actor_id,session_id,operation_id) values(r.id,previous,destination,'SESSION_CHECKOUT',a,s.id,p_operation_id) returning id into event_id;
 end if;
 elsif p_action in ('TRANSFER','RECEIVE','CORRECT') then
 if p_action='CORRECT' then
 if private.active_role()<>'ADMIN' then raise exception 'Administrator access required.'; end if;
 if length(btrim(coalesce(p_payload->>'reason',''))) not between 1 and 160 then raise exception 'A correction reason is required (maximum 160 characters).'; end if;
 destination=p_payload->'destination'; perform private.valid_holder(destination,a,false);
 else
 if k.room_id is null then raise exception 'Key status not initialized. Contact an administrator.'; end if;
 if p_action='TRANSFER' then
 if s.id is not null then raise exception 'Check out or recover the active session first.'; end if;
 if k.holder_type<>'MEMBER' or k.holder_member_id<>a then raise exception 'Only the recorded holder can transfer this key.'; end if;
 destination=p_payload->'destination'; perform private.valid_holder(destination,a);
 else
 perform private.valid_holder(p_payload->'source',a);
 if s.member_id=a then raise exception 'You already own the active session.'; end if;
 destination=private.holder('MEMBER',a);
 if s.id is not null then
 if coalesce(p_payload->>'recoveryReason','') not in ('PREVIOUS_BAND_LEFT','RECEIVED_KEY_FROM_PREVIOUS_USER','RECEIVED_KEY_FROM_SW','RECEIVED_KEY_FROM_MHO','OTHER') then raise exception 'Select a recovery reason.'; end if;
 if length(coalesce(p_payload->>'recoveryRemarks',''))>500 or (p_payload->>'recoveryReason'='OTHER' and length(btrim(coalesce(p_payload->>'recoveryRemarks','')))=0) then raise exception 'Other requires remarks (maximum 500 characters).'; end if;
 end if;
 end if;
 end if;
 if s.id is not null and (p_action='RECEIVE' or (p_action='CORRECT' and destination<>private.holder('MEMBER',s.member_id))) then
 reason=case when p_action='RECEIVE' then 'KEY_MOVED_DURING_ACTIVE_SESSION' else 'ADMIN_RECOVERY' end;
 update public.sessions set status='INCOMPLETE',closed_at=now(),closed_by=a,closure_reason=reason,
 recovery_reason=case when p_action='RECEIVE' then p_payload->>'recoveryReason' else null end,
 recovery_remarks=case when p_action='RECEIVE' then btrim(p_payload->>'recoveryRemarks') else btrim(p_payload->>'reason') end,version=version+1 where id=s.id;
 insert into public.flags(room_id,type,subject_member_id,session_id) values(r.id,'MISSING_END_CHECKOUT',s.member_id,s.id);
 insert into public.operational_audit(actor_id,room_id,session_id,event,operation_id,details) values(a,r.id,s.id,'SESSION_CLOSED',p_operation_id,jsonb_build_object('reason',reason,'outcome','INCOMPLETE','recoveryReason',p_payload->>'recoveryReason','recoveryRemarks',p_payload->>'recoveryRemarks'));
 end if;
 insert into public.key_custody_events(room_id,previous_recorded_holder,reported_source,new_holder,mode,actor_id,session_id,mismatch,reason,operation_id)
 values(r.id,previous,case when p_action='RECEIVE' then p_payload->'source' else null end,destination,
 case when p_action='RECEIVE' then 'INCOMING' when p_action='CORRECT' then 'ADMIN_CORRECTION' else 'OUTGOING' end,a,s.id,
 p_action='RECEIVE' and previous<>p_payload->'source',p_payload->>'reason',p_operation_id) returning id into event_id;
 if p_action='RECEIVE' and previous<>p_payload->'source' then insert into public.flags(room_id,type,subject_member_id,session_id,custody_event_id) values(r.id,'KEY_CUSTODY_MISMATCH',a,s.id,event_id); end if;
 if p_action='CORRECT' then insert into public.operational_audit(actor_id,room_id,session_id,custody_event_id,event,operation_id,details) values(a,r.id,s.id,event_id,'ADMIN_CORRECTION',p_operation_id,p_payload); end if;
 elsif p_action='RESOLVE_FLAG' then
 if private.active_role()<>'ADMIN' then raise exception 'Administrator access required.'; end if;
 select * into flag_row from public.flags where id=(p_payload->>'flagId')::uuid and room_id=r.id for update;
 if not found or flag_row.status<>'OPEN' then raise exception 'This flag is no longer open.'; end if;
 if length(coalesce(p_payload->>'note',''))>160 then raise exception 'Keep remarks within 160 characters.'; end if;
 update public.flags set status='RESOLVED',resolved_by=a,resolved_at=now(),resolution_note=btrim(p_payload->>'note') where id=flag_row.id;
 insert into public.operational_audit(actor_id,room_id,session_id,custody_event_id,event,operation_id,details) values(a,r.id,flag_row.session_id,flag_row.custody_event_id,'FLAG_RESOLVED',p_operation_id,p_payload);
 else raise exception 'Unknown operational command.'; end if;
 if event_id is not null then insert into public.operational_audit(actor_id,room_id,session_id,custody_event_id,event,operation_id,details) values(a,r.id,s.id,event_id,'KEY_CUSTODY_RECORDED',p_operation_id,jsonb_build_object('previousRecordedHolder',previous,'reportedSource',p_payload->'source','newHolder',destination)); end if;
 if p_action<>'RESOLVE_FLAG' then
 update public.rooms set version=version+1,updated_at=now() where id=r.id;
 if destination is not null then
 insert into public.room_key_state(room_id,holder_type,holder_member_id,updated_by,version) values(r.id,case when destination->>'type'='member' then 'MEMBER' else upper(destination->>'id') end,case when destination->>'type'='member' then (destination->>'id')::uuid else null end,a,r.version+1)
 on conflict(room_id) do update set holder_type=excluded.holder_type,holder_member_id=excluded.holder_member_id,updated_at=now(),updated_by=a,version=excluded.version;
 else update public.room_key_state set version=r.version+1,updated_at=now(),updated_by=a where room_id=r.id; end if;
 else update public.rooms set updated_at=now() where id=r.id;
 end if;
 result=jsonb_build_object('ok',true,'sessionId',coalesce(p_session_id,s.id),'version',r.version+case when p_action='RESOLVE_FLAG' then 0 else 1 end);
 insert into public.processed_operations(operation_id,actor_id,request,session_id,result) values(p_operation_id,a,req,coalesce(p_session_id,s.id),result);
 return result;
end; $$;
-- Browser reads use RLS; a snapshot RPC returns all visible rows at one MVCC snapshot.
create function public.operational_snapshot() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
 'rooms',coalesce((select jsonb_agg(x order by x.display_name) from public.rooms x),'[]'::jsonb),
 'keys',coalesce((select jsonb_agg(x) from public.room_key_state x),'[]'::jsonb),
 'sessions',coalesce((select jsonb_agg(x order by x.started_at desc) from public.sessions x),'[]'::jsonb),
 'photos',coalesce((select jsonb_agg(x) from public.session_photos x),'[]'::jsonb),
 'custody',coalesce((select jsonb_agg(x order by x.created_at desc) from public.key_custody_events x),'[]'::jsonb),
 'flags',coalesce((select jsonb_agg(x order by x.created_at desc) from public.flags x),'[]'::jsonb),
 'audit',coalesce((select jsonb_agg(x order by x.created_at desc) from public.operational_audit x),'[]'::jsonb)
 );
$$;
do $$ declare t text; begin
 foreach t in array array['rooms','room_key_state','sessions','session_photos','key_custody_events','flags','operational_audit','processed_operations','photo_uploads'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public, anon, authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 end loop;
end; $$;
create policy rooms_read on public.rooms for select to authenticated using(private.active_member() is not null);
create policy keys_read on public.room_key_state for select to authenticated using(private.active_member() is not null);
create policy sessions_read on public.sessions for select to authenticated using(private.active_member() is not null and (status='ACTIVE' or member_id=private.active_member() or private.active_role()='ADMIN'));
create policy photos_read on public.session_photos for select to authenticated using(private.active_member() is not null and (private.active_role()='ADMIN' or exists(select 1 from public.sessions s where s.id=session_id and s.member_id=private.active_member())));
create policy custody_read on public.key_custody_events for select to authenticated using(private.active_member() is not null and (private.active_role()='ADMIN' or actor_id=private.active_member() or previous_recorded_holder->>'id'=private.active_member()::text or reported_source->>'id'=private.active_member()::text or new_holder->>'id'=private.active_member()::text));
create policy flags_read on public.flags for select to authenticated using(private.active_member() is not null and (private.active_role()='ADMIN' or subject_member_id=private.active_member()));
create policy audit_read on public.operational_audit for select to authenticated using(private.active_member() is not null and (private.active_role()='ADMIN' or actor_id=private.active_member() or exists(select 1 from public.sessions s where s.id=session_id and s.member_id=private.active_member())));
create policy operations_read on public.processed_operations for select to authenticated using(actor_id=private.active_member());
create policy uploads_read on public.photo_uploads for select to authenticated using(auth_user_id=auth.uid() and private.active_member() is not null);
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('session-photos','session-photos',false,512000,array['image/jpeg'])
on conflict(id) do update set public=false,file_size_limit=512000,allowed_mime_types=array['image/jpeg'];
-- No UPDATE/DELETE policy: historical objects cannot be overwritten or removed.
create function private.can_upload_photo(p_path text) returns boolean language sql stable security definer set search_path='' as $$
 select private.active_member() is not null and exists(select 1 from public.photo_uploads u where u.storage_path=p_path and u.auth_user_id=auth.uid() and not u.deleting and u.expires_at>now()
 and (u.stage='START' and not exists(select 1 from public.sessions where id=u.session_id) or u.stage='END' and exists(select 1 from public.sessions where id=u.session_id and member_id=private.active_member() and status='ACTIVE')));
$$;
create function private.can_read_photo(p_path text) returns boolean language sql stable security definer set search_path='' as $$
 select private.active_member() is not null and exists(select 1 from public.session_photos p join public.sessions s on s.id=p.session_id where p.storage_path=p_path and (private.active_role()='ADMIN' or s.member_id=private.active_member()));
$$;
create policy session_photo_upload on storage.objects for insert to authenticated with check(bucket_id='session-photos' and private.can_upload_photo(name) and owner_id=auth.uid()::text);
create policy session_photo_read on storage.objects for select to authenticated using(bucket_id='session-photos' and private.can_read_photo(name));
-- Restrictive guards prevent unrelated broad permissive Storage policies from
-- granting access to this private bucket. Other buckets keep their own policies.
create policy session_photo_upload_guard on storage.objects as restrictive for insert to authenticated
 with check(bucket_id<>'session-photos' or (private.can_upload_photo(name) and owner_id=auth.uid()::text));
create policy session_photo_read_guard on storage.objects as restrictive for select to authenticated
 using(bucket_id<>'session-photos' or private.can_read_photo(name));
create policy session_photo_anon_read_guard on storage.objects as restrictive for select to anon using(bucket_id<>'session-photos');
create policy session_photo_anon_upload_guard on storage.objects as restrictive for insert to anon with check(bucket_id<>'session-photos');
create policy session_photo_no_update on storage.objects as restrictive for update to anon,authenticated using(bucket_id<>'session-photos') with check(bucket_id<>'session-photos');
create policy session_photo_no_delete on storage.objects as restrictive for delete to anon,authenticated using(bucket_id<>'session-photos');
revoke all on function private.active_member(),private.check_disable_custody(),private.freeze_terminal_session(),private.freeze_evidence(),private.holder(text,uuid),private.valid_holder(jsonb,uuid,boolean),private.attach_photo(uuid,uuid,text,text,uuid,jsonb),private.can_upload_photo(text),private.can_read_photo(text) from public,anon,authenticated;
grant execute on function private.active_member(),private.can_upload_photo(text),private.can_read_photo(text) to authenticated;
revoke all on function public.operational_directory(),public.operational_snapshot(),public.register_photo_upload(uuid,uuid,text,text),public.operational_command(uuid,text,uuid,bigint,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.operational_directory(),public.operational_snapshot(),public.register_photo_upload(uuid,uuid,text,text),public.operational_command(uuid,text,uuid,bigint,uuid,jsonb) to authenticated;
-- Realtime broadcasts room versions only. Every client refetches its RLS snapshot.
-- Sensitive terminal histories/photos are never added to the publication.
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
 alter publication supabase_realtime add table public.rooms;
 end if;
end; $$;
commit;
