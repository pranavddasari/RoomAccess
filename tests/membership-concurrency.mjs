// Optional full PostgreSQL multi-connection test. PG_BIN must contain initdb,
// pg_ctl and psql. Uses a disposable cluster, never your Supabase database.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const exec=promisify(execFile), bin=process.env.PG_BIN || '/opt/homebrew/opt/postgresql@16/bin';
const root=await mkdtemp(join(tmpdir(),'music-membership-pg-')), data=join(root,'data');
let started=false;
const psql=sql=>exec(join(bin,'psql'),['-h',root,'-p','55439','-U','membership_test','-d','postgres','-v','ON_ERROR_STOP=1','-At','-c',sql]);
try {
 await exec(join(bin,'initdb'),['-D',data,'-U','membership_test','-A','trust','--no-locale']);
 await exec(join(bin,'pg_ctl'),['-D',data,'-l',join(root,'server.log'),'-o',`-h '' -k '${root}' -p 55439`,'-w','start']);started=true;
 await psql(`create role anon; create role authenticated; create role supabase_auth_admin;
 create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql as $$select '{"app_metadata":{"provider":"google"}}'::jsonb$$;
 grant usage on schema auth to authenticated; grant execute on all functions in schema auth to authenticated;`);
 await psql(await readFile(new URL('../supabase/migrations/202610050001_membership.sql',import.meta.url),'utf8'));
 const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
 for(const [i,id] of ids.entries())await psql(`insert into auth.users values('${id}','admin${i}@vitstudent.ac.in',now());
 insert into auth.identities values('${id}','google','{"email":"admin${i}@vitstudent.ac.in","email_verified":true}');
 insert into club_members(id,email,name,auth_user_id,role) values('${id}','admin${i}@vitstudent.ac.in','Admin ${i}','${id}','ADMIN');`);
 // Two independent connections attempt to demote themselves while both were admins.
 // Both transactions overlap. The first holds the singleton until its commit.
 const results=await Promise.allSettled(ids.map(id=>psql(`begin; set role authenticated; select set_config('test.uid','${id}',true); select public.change_club_member('${id}','MEMBER',null); select pg_sleep(0.4); commit;`)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.match(results.find(r=>r.status==='rejected').reason.stderr,/At least one active administrator/);
 assert.equal((await psql("select count(*) from club_members where role='ADMIN' and status='ACTIVE'")).stdout.trim(),'1');
 console.log('PASS: overlapping administrator demotions preserve one ACTIVE ADMIN.');
} finally {
 if(started)await exec(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop']);
 await rm(root,{recursive:true,force:true});
}
