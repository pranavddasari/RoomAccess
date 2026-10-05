begin;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table private.membership_lock (id boolean primary key default true check(id));
insert into private.membership_lock values (true);
create table public.club_members (
 id uuid primary key default gen_random_uuid(),
 email text not null unique check(email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@vitstudent[.]ac[.]in$'),
 name text not null check(length(btrim(name)) between 1 and 120),
 auth_user_id uuid unique references auth.users(id),
 role text not null default 'MEMBER' check(role in ('MEMBER','ADMIN')),
 status text not null default 'ACTIVE' check(status in ('ACTIVE','DISABLED')),
 created_at timestamptz not null default now(), created_by uuid references auth.users(id),
 updated_at timestamptz not null default now(), updated_by uuid references auth.users(id)
);
create table public.membership_audit (
 id uuid primary key default gen_random_uuid(), target_membership uuid not null references public.club_members(id),
 actor_id uuid references auth.users(id), timestamp timestamptz not null default now(),
 event text not null check(event in ('MEMBER_ADDED','ROLE_CHANGED','MEMBER_DISABLED','MEMBER_ENABLED')),
 before_value jsonb, after_value jsonb not null
);
-- Identity data is read from Auth-owned tables, never editable user_metadata.
create function private.verified_google_email() returns text language sql stable security definer set search_path = '' as $$
 select lower(u.email) from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null
 and lower(u.email) ~ '^[^@[:space:]]+@vitstudent[.]ac[.]in$'
 and auth.jwt()->'app_metadata'->>'provider' = 'google'
 and exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='google'
 and i.identity_data->>'email_verified' = 'true' and lower(i.identity_data->>'email')=lower(u.email));
$$;
create function private.active_role() returns text language sql stable security definer set search_path = '' as $$
 select role from public.club_members where auth_user_id=auth.uid() and email=private.verified_google_email() and status='ACTIVE';
$$;
create function private.lock_memberships() returns void language plpgsql security definer set search_path = '' as $$
begin
 -- Updating a singleton serializes writes; stronger isolation yields a serialization
 -- failure rather than allowing a stale snapshot to remove the final administrator.
 update private.membership_lock set id=true where id=true;
end; $$;
create function private.guard_membership() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 perform private.lock_memberships();
 if TG_OP='DELETE' then raise exception 'Memberships cannot be deleted; disable access instead.'; end if;
 if TG_OP='UPDATE' and old.role='ADMIN' and old.status='ACTIVE' and (new.role<>'ADMIN' or new.status<>'ACTIVE')
 and not exists(select 1 from public.club_members where id<>old.id and role='ADMIN' and status='ACTIVE') then
 raise exception 'At least one active administrator must remain.';
 end if;
 if TG_OP='INSERT' then new.email=lower(btrim(new.email)); new.created_by=auth.uid(); end if;
 new.updated_at=now(); new.updated_by=auth.uid(); return new;
end; $$;
create trigger membership_guard before insert or update or delete on public.club_members for each row execute function private.guard_membership();
create function private.audit_membership() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if TG_OP='INSERT' then
 insert into public.membership_audit(target_membership,actor_id,event,after_value) values(new.id,auth.uid(),'MEMBER_ADDED',to_jsonb(new));
 else
 if old.role<>new.role then insert into public.membership_audit(target_membership,actor_id,event,before_value,after_value) values(new.id,auth.uid(),'ROLE_CHANGED',to_jsonb(old),to_jsonb(new)); end if;
 if old.status<>new.status then insert into public.membership_audit(target_membership,actor_id,event,before_value,after_value) values(new.id,auth.uid(),case when new.status='ACTIVE' then 'MEMBER_ENABLED' else 'MEMBER_DISABLED' end,to_jsonb(old),to_jsonb(new)); end if;
 end if; return new;
end; $$;
create trigger membership_audit after insert or update on public.club_members for each row execute function private.audit_membership();
create function public.authorize_membership() returns jsonb language plpgsql security definer set search_path = '' as $$
declare e text; m public.club_members;
begin
 e=private.verified_google_email();
 if e is null then return jsonb_build_object('state','DOMAIN_DENIED'); end if;
 perform private.lock_memberships();
 select * into m from public.club_members where email=e for update;
 if not found then return jsonb_build_object('state','NOT_REGISTERED'); end if;
 if m.status='DISABLED' then return jsonb_build_object('state','DISABLED'); end if;
 if m.auth_user_id is not null and m.auth_user_id<>auth.uid() then return jsonb_build_object('state','IDENTITY_CONFLICT'); end if;
 if m.auth_user_id is null then update public.club_members set auth_user_id=auth.uid() where id=m.id returning * into m; end if;
 return jsonb_build_object('state','ACTIVE','member',to_jsonb(m));
end; $$;
create function public.member_directory() returns table(id uuid,name text) language sql stable security definer set search_path = '' as $$
 select id,name from public.club_members where status='ACTIVE' and private.active_role() in ('MEMBER','ADMIN') order by name;
$$;
create function public.add_club_member(p_name text,p_email text,p_role text default 'MEMBER') returns public.club_members language plpgsql security definer set search_path = '' as $$
declare m public.club_members;
begin
 perform private.lock_memberships();
 if private.active_role() is distinct from 'ADMIN' then raise exception 'Administrator access required.'; end if;
 insert into public.club_members(name,email,role) values(btrim(p_name),lower(btrim(p_email)),p_role) returning * into m; return m;
end; $$;
create function public.change_club_member(p_id uuid,p_role text default null,p_status text default null) returns public.club_members language plpgsql security definer set search_path = '' as $$
declare m public.club_members;
begin
 perform private.lock_memberships();
 if private.active_role() is distinct from 'ADMIN' then raise exception 'Administrator access required.'; end if;
 update public.club_members set role=coalesce(p_role,role),status=coalesce(p_status,status) where id=p_id returning * into m;
 if not found then raise exception 'Membership not found.'; end if;
 return m;
end; $$;
create function public.before_user_created(event jsonb) returns jsonb language plpgsql set search_path = '' as $$
begin
 if coalesce(event->'user'->'app_metadata'->>'provider','')<>'google'
 or coalesce(lower(event->'user'->>'email'),'') !~ '^[^@[:space:]]+@vitstudent[.]ac[.]in$' then
 return jsonb_build_object('error',jsonb_build_object('http_code',403,'message','This website is available only to approved Music Club members using a @vitstudent.ac.in Google account.'));
 end if;
 return '{}'::jsonb;
end; $$;
alter table public.club_members enable row level security;
alter table public.membership_audit enable row level security;
revoke all on public.club_members, public.membership_audit from public, anon, authenticated;
grant select on public.club_members, public.membership_audit to authenticated;
grant usage on schema private to authenticated;
grant execute on function private.active_role(), private.verified_google_email() to authenticated;
create policy roster_read on public.club_members for select to authenticated using (private.active_role()='ADMIN' or (auth_user_id=auth.uid() and status='ACTIVE' and email=private.verified_google_email()));
create policy audit_admin_read on public.membership_audit for select to authenticated using (private.active_role()='ADMIN');
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.active_role(), private.verified_google_email() to authenticated;
revoke all on function public.authorize_membership(),public.member_directory(),public.add_club_member(text,text,text),public.change_club_member(uuid,text,text),public.before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.authorize_membership(),public.member_directory(),public.add_club_member(text,text,text),public.change_club_member(uuid,text,text) to authenticated;
grant execute on function public.before_user_created(jsonb) to supabase_auth_admin;
commit;
