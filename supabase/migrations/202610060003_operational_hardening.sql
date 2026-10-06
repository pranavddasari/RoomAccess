begin;
-- Forward correction: preserve the original operations and retention migrations.
create or replace function public.operational_directory() returns table(id uuid,name text)
language sql stable security definer set search_path='' as $$
 select id,name from public.club_members
 where status='ACTIVE' and private.active_member() is not null order by name;
$$;

-- Only these two keys are custody facts. Membership is checked against the server.
-- Retry fingerprints may refer to a now-disabled member; fresh movements may not.
create function private.canonical_holder(p_holder jsonb,p_actor uuid,p_no_self boolean default true,p_require_active boolean default true)
returns jsonb language plpgsql security definer set search_path='' as $$
declare member_id uuid;
begin
 if jsonb_typeof(p_holder) is distinct from 'object' or
    jsonb_typeof(p_holder->'type') is distinct from 'string' or
    jsonb_typeof(p_holder->'id') is distinct from 'string' then
 raise exception 'Choose a valid key holder.';
 end if;
 if p_holder->>'type'='member' then
 begin member_id=(p_holder->>'id')::uuid;
 exception when invalid_text_representation then raise exception 'Choose a valid key holder.';
 end;
 if not exists(select 1 from public.club_members where id=member_id and (not p_require_active or status='ACTIVE')) then
 raise exception 'Choose an active club member.';
 end if;
 if p_no_self and member_id=p_actor then raise exception 'You cannot transfer a key to yourself.'; end if;
 return private.holder('MEMBER',member_id);
 elsif p_holder->>'type'='location' and p_holder->>'id' in ('sw','mho') then
 return jsonb_build_object('type','location','id',p_holder->>'id');
 end if;
 raise exception 'Choose a valid key holder.';
end; $$;

-- Normalize only the holder fields relevant to each command, before comparing
-- operation IDs. The command rechecks ACTIVE recipients and self-transfer rules
-- after the retry lookup, so a successful retry survives subsequent disablement.
create function private.canonical_operational_payload(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare field text; value jsonb;
begin
 field=case when p_action='RECEIVE' then 'source' when p_action in ('TRANSFER','CORRECT','END') then 'destination' else null end;
 if field is null then return p_payload; end if;
 value=p_payload->field;
 if p_action='END' and jsonb_typeof(value)='object' and value->>'type'='retain' then
 value=jsonb_build_object('type','retain');
 else value=private.canonical_holder(value,null,false,false); end if;
 return jsonb_set(p_payload,array[field],value);
end; $$;

create or replace function public.operational_command(p_operation_id uuid,p_action text,p_room_id uuid,p_expected_version bigint,p_session_id uuid default null,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare a uuid; r public.rooms; k public.room_key_state; s public.sessions; prior public.processed_operations;
 payload jsonb; req jsonb; result jsonb; destination jsonb; source jsonb; disposition jsonb; previous jsonb; event_id uuid; flag_row public.flags; reason text;
begin
 perform private.lock_memberships(); a=private.active_member(); if a is null then raise exception 'Active membership required.'; end if;
 payload=private.canonical_operational_payload(p_action,p_payload);
 req=jsonb_build_object('action',p_action,'room',p_room_id,'version',p_expected_version,'session',p_session_id,'payload',payload);
 select * into prior from public.processed_operations where operation_id=p_operation_id;
 if found then
 if prior.actor_id<>a or (prior.request || jsonb_build_object('payload',private.canonical_operational_payload(prior.request->>'action',prior.request->'payload')))<>req then raise exception 'Operation ID conflicts with another command.'; end if;
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
 perform private.attach_photo((payload->'roomPhoto'->>'id')::uuid,p_session_id,'START','ROOM',a,payload->'roomPhoto');
 perform private.attach_photo((payload->'cablesPhoto'->>'id')::uuid,p_session_id,'START','CABLES',a,payload->'cablesPhoto');
 insert into public.operational_audit(actor_id,room_id,session_id,event,operation_id) values(a,r.id,p_session_id,'SESSION_STARTED',p_operation_id);
 elsif p_action='END_PHOTO' then
 perform private.attach_photo((payload->>'id')::uuid,s.id,'END',payload->>'category',a,payload);
 update public.sessions set version=version+1 where id=s.id;
 elsif p_action in ('END','SELF_RECOVER') then
 if k.holder_type is distinct from 'MEMBER' or k.holder_member_id is distinct from a then raise exception 'You must hold this room key.'; end if;
 if p_action='END' then
 if (select count(*) from public.session_photos where session_id=s.id and stage='END')<>2 then raise exception 'Both accepted end photos are required.'; end if;
 destination=payload->'destination';
 disposition=destination;
 if destination->>'type'='retain' then destination=private.holder('MEMBER',a);
 else destination=private.canonical_holder(destination,a); disposition=destination; end if;
 reason='NORMAL_CHECKOUT';
 else destination=previous; reason='MISSED_CHECKOUT_SELF_REPORTED'; end if;
 update public.sessions set status=case when p_action='END' then 'COMPLETE' else 'INCOMPLETE' end,closed_at=now(),closed_by=a,closure_reason=reason,
 key_disposition=disposition,version=version+1 where id=s.id;
 insert into public.operational_audit(actor_id,room_id,session_id,event,operation_id,details) values(a,r.id,s.id,'SESSION_CLOSED',p_operation_id,jsonb_build_object('reason',reason,'outcome',case when p_action='END' then 'COMPLETE' else 'INCOMPLETE' end,'keyDisposition',disposition));
 if p_action='SELF_RECOVER' then insert into public.flags(room_id,type,subject_member_id,session_id) values(r.id,'MISSING_END_CHECKOUT',s.member_id,s.id); end if;
 if p_action='END' and payload->'destination'->>'type'<>'retain' then
 insert into public.key_custody_events(room_id,previous_recorded_holder,new_holder,mode,actor_id,session_id,operation_id) values(r.id,previous,destination,'SESSION_CHECKOUT',a,s.id,p_operation_id) returning id into event_id;
 end if;
 elsif p_action in ('TRANSFER','RECEIVE','CORRECT') then
 if p_action='CORRECT' then
 if private.active_role()<>'ADMIN' then raise exception 'Administrator access required.'; end if;
 if length(btrim(coalesce(payload->>'reason',''))) not between 1 and 160 then raise exception 'A correction reason is required (maximum 160 characters).'; end if;
 destination=private.canonical_holder(payload->'destination',a,false);
 else
 if k.room_id is null then raise exception 'Key status not initialized. Contact an administrator.'; end if;
 if p_action='TRANSFER' then
 if s.id is not null then raise exception 'Check out or recover the active session first.'; end if;
 if k.holder_type<>'MEMBER' or k.holder_member_id<>a then raise exception 'Only the recorded holder can transfer this key.'; end if;
 destination=private.canonical_holder(payload->'destination',a);
 else
 source=private.canonical_holder(payload->'source',a);
 if s.member_id=a then raise exception 'You already own the active session.'; end if;
 destination=private.holder('MEMBER',a);
 if s.id is not null then
 if coalesce(payload->>'recoveryReason','') not in ('PREVIOUS_BAND_LEFT','RECEIVED_KEY_FROM_PREVIOUS_USER','RECEIVED_KEY_FROM_SW','RECEIVED_KEY_FROM_MHO','OTHER') then raise exception 'Select a recovery reason.'; end if;
 if length(coalesce(payload->>'recoveryRemarks',''))>500 or (payload->>'recoveryReason'='OTHER' and length(btrim(coalesce(payload->>'recoveryRemarks','')))=0) then raise exception 'Other requires remarks (maximum 500 characters).'; end if;
 end if;
 end if;
 end if;
 if s.id is not null and (p_action='RECEIVE' or (p_action='CORRECT' and destination<>private.holder('MEMBER',s.member_id))) then
 reason=case when p_action='RECEIVE' then 'KEY_MOVED_DURING_ACTIVE_SESSION' else 'ADMIN_RECOVERY' end;
 update public.sessions set status='INCOMPLETE',closed_at=now(),closed_by=a,closure_reason=reason,
 recovery_reason=case when p_action='RECEIVE' then payload->>'recoveryReason' else null end,
 recovery_remarks=case when p_action='RECEIVE' then btrim(payload->>'recoveryRemarks') else btrim(payload->>'reason') end,version=version+1 where id=s.id;
 insert into public.flags(room_id,type,subject_member_id,session_id) values(r.id,'MISSING_END_CHECKOUT',s.member_id,s.id);
 insert into public.operational_audit(actor_id,room_id,session_id,event,operation_id,details) values(a,r.id,s.id,'SESSION_CLOSED',p_operation_id,jsonb_build_object('reason',reason,'outcome','INCOMPLETE','recoveryReason',payload->>'recoveryReason','recoveryRemarks',payload->>'recoveryRemarks'));
 end if;
 insert into public.key_custody_events(room_id,previous_recorded_holder,reported_source,new_holder,mode,actor_id,session_id,mismatch,reason,operation_id)
 values(r.id,previous,source,destination,
 case when p_action='RECEIVE' then 'INCOMING' when p_action='CORRECT' then 'ADMIN_CORRECTION' else 'OUTGOING' end,a,s.id,
 p_action='RECEIVE' and previous<>source,payload->>'reason',p_operation_id) returning id into event_id;
 if p_action='RECEIVE' and previous<>source then insert into public.flags(room_id,type,subject_member_id,session_id,custody_event_id) values(r.id,'KEY_CUSTODY_MISMATCH',a,s.id,event_id); end if;
 if p_action='CORRECT' then insert into public.operational_audit(actor_id,room_id,session_id,custody_event_id,event,operation_id,details) values(a,r.id,s.id,event_id,'ADMIN_CORRECTION',p_operation_id,jsonb_build_object('destination',destination,'reason',payload->>'reason')); end if;
 elsif p_action='RESOLVE_FLAG' then
 if private.active_role()<>'ADMIN' then raise exception 'Administrator access required.'; end if;
 select * into flag_row from public.flags where id=(payload->>'flagId')::uuid and room_id=r.id for update;
 if not found or flag_row.status<>'OPEN' then raise exception 'This flag is no longer open.'; end if;
 if length(coalesce(payload->>'note',''))>160 then raise exception 'Keep remarks within 160 characters.'; end if;
 update public.flags set status='RESOLVED',resolved_by=a,resolved_at=now(),resolution_note=btrim(payload->>'note') where id=flag_row.id;
 insert into public.operational_audit(actor_id,room_id,session_id,custody_event_id,event,operation_id,details) values(a,r.id,flag_row.session_id,flag_row.custody_event_id,'FLAG_RESOLVED',p_operation_id,payload);
 else raise exception 'Unknown operational command.'; end if;
 if event_id is not null then insert into public.operational_audit(actor_id,room_id,session_id,custody_event_id,event,operation_id,details) values(a,r.id,s.id,event_id,'KEY_CUSTODY_RECORDED',p_operation_id,jsonb_build_object('previousRecordedHolder',previous,'reportedSource',source,'newHolder',destination)); end if;
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
revoke all on function private.canonical_holder(jsonb,uuid,boolean,boolean),private.canonical_operational_payload(text,jsonb) from public,anon,authenticated;
revoke all on function public.operational_directory(),public.operational_command(uuid,text,uuid,bigint,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.operational_directory(),public.operational_command(uuid,text,uuid,bigint,uuid,jsonb) to authenticated;
commit;
