import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
let db;
const admin='11111111-1111-4111-8111-111111111111', member='22222222-2222-4222-8222-222222222222', other='33333333-3333-4333-8333-333333333333';
before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role supabase_auth_admin;
 create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql as $$select jsonb_build_object('app_metadata',jsonb_build_object('provider',coalesce(nullif(current_setting('test.provider',true),''),'google')))$$;
 grant usage on schema auth to authenticated; grant execute on all functions in schema auth to authenticated;`);
 await db.exec(await readFile(new URL('../supabase/migrations/202610050001_membership.sql',import.meta.url),'utf8'));
 for(const [id,email] of [[admin,'admin'],[member,'member'],[other,'other']]) {
  await db.query('insert into auth.users values($1,$2,now())',[id,`${email}@vitstudent.ac.in`]);
  await db.query("insert into auth.identities values($1,'google',$2)",[id,JSON.stringify({email:`${email}@vitstudent.ac.in`,email_verified:true})]);
 }
 await db.exec("insert into public.club_members(email,name,role) values ('admin@vitstudent.ac.in','Admin','ADMIN'),('member@vitstudent.ac.in','Member','MEMBER');");
});
after(async()=>db.close());
async function as(id,sql,args=[]) {
 await db.exec('reset role'); await db.query("select set_config('test.uid',$1,false)",[id??'']);
 await db.exec(id?'set role authenticated':'set role anon');
 try{return await db.query(sql,args);}finally{await db.exec('reset role');}
}
async function authorize(id){return (await as(id,'select public.authorize_membership() as result')).rows[0].result;}
async function add(role,email=`added-${role.toLowerCase()}@vitstudent.ac.in`){return (await as(admin,'select * from public.add_club_member($1,$2,$3)',['Added',email,role])).rows[0];}
test('anonymous cannot call membership functions or read roster',async()=>{
 await assert.rejects(as(null,'select public.authorize_membership()'),/permission denied/);
 await assert.rejects(as(null,'select * from public.club_members'),/permission denied/);
});
test('preauthorized first login links only the verified identity and is idempotent',async()=>{
 const a=await authorize(admin),m=await authorize(member);assert.equal(a.state,'ACTIVE');assert.equal(a.member.auth_user_id,admin);assert.equal(m.member.role,'MEMBER');
 assert.equal((await authorize(member)).member.id,m.member.id);
});
test('unknown VIT account receives denial and creates no membership',async()=>{
 assert.equal((await authorize(other)).state,'NOT_REGISTERED');
 assert.equal((await db.query('select count(*)::int as n from club_members')).rows[0].n,2);
});
test('member sees own row only, cannot view audits or elevate via SQL or RPC',async()=>{
 assert.equal((await as(member,'select * from club_members')).rows.length,1);
 assert.equal((await as(member,'select * from membership_audit')).rows.length,0);
 await assert.rejects(as(member,"update club_members set role='ADMIN'"),/permission denied/);
 await assert.rejects(as(member,"select public.add_club_member('X','x@vitstudent.ac.in','ADMIN')"),/Administrator access required/);
 const id=(await authorize(member)).member.id;
 await assert.rejects(as(member,"select public.change_club_member($1,'ADMIN',null)",[id]),/Administrator access required/);
});
test('admin can add Member and Admin, email is normalized, Auth account is not created',async()=>{
 const m=await add('MEMBER',' ADDED-MEMBER@vitstudent.ac.in '), a=await add('ADMIN');
 assert.equal(m.email,'added-member@vitstudent.ac.in');assert.equal(m.auth_user_id,null);assert.equal(m.created_by,admin);assert.equal(a.role,'ADMIN');
 assert.equal((await db.query('select count(*)::int as n from auth.users')).rows[0].n,3);
});
test('duplicate and misleading domains are rejected in database',async()=>{
 await assert.rejects(add('MEMBER','ADDED-MEMBER@vitstudent.ac.in'),/unique/);
 for(const e of ['x@gmail.com','x@vit.ac.in','x@vitstudent.ac.in.fake','x@y@vitstudent.ac.in']) await assert.rejects(add('MEMBER',e),/check constraint/);
});
test('role changes are audited, demotion succeeds with another active admin',async()=>{
 const m=(await authorize(member)).member;
 await as(admin,"select public.change_club_member($1,'ADMIN',null)",[m.id]);
 const event=(await db.query("select * from membership_audit where target_membership=$1 and event='ROLE_CHANGED'",[m.id])).rows[0];
 assert.equal(event.before_value.role,'MEMBER');assert.equal(event.after_value.role,'ADMIN');assert.equal(event.actor_id,admin);
 await as(admin,"select public.change_club_member($1,'MEMBER',null)",[m.id]); assert.equal((await authorize(member)).member.role,'MEMBER');
});
test('disable and re-enable preserve membership identity and audit history',async()=>{
 const m=(await authorize(member)).member;
 await as(admin,"select public.change_club_member($1,null,'DISABLED')",[m.id]);assert.equal((await authorize(member)).state,'DISABLED');
 assert.equal((await as(member,'select * from club_members')).rows.length,0);
 await assert.rejects(as(member,"select public.add_club_member('X','x@vitstudent.ac.in','MEMBER')"),/Administrator access required/);
 await as(admin,"select public.change_club_member($1,null,'ACTIVE')",[m.id]);assert.equal((await authorize(member)).member.id,m.id);
 const events=(await db.query('select event from membership_audit where target_membership=$1',[m.id])).rows.map(e=>e.event); assert.ok(events.includes('MEMBER_DISABLED'));assert.ok(events.includes('MEMBER_ENABLED'));
});
test('last admin cannot be demoted, disabled, or deleted, even via trusted SQL',async()=>{
 const extra=(await db.query("select id from club_members where email='added-admin@vitstudent.ac.in'")).rows[0];
 await as(admin,"select public.change_club_member($1,'MEMBER',null)",[extra.id]);
 const a=(await authorize(admin)).member;
 await assert.rejects(as(admin,"select public.change_club_member($1,'MEMBER',null)",[a.id]),/At least one active administrator/);
 await assert.rejects(as(admin,"select public.change_club_member($1,null,'DISABLED')",[a.id]),/At least one active administrator/);
 await assert.rejects(db.query('delete from club_members where id=$1',[a.id]),/cannot be deleted/);
});
test('already-linked different identity fails without relinking',async()=>{
 const m=(await authorize(member)).member;
 await db.query('update club_members set auth_user_id=$1 where id=$2',[other,m.id]);
 assert.equal((await authorize(member)).state,'IDENTITY_CONFLICT');
 assert.equal((await db.query('select auth_user_id from club_members where id=$1',[m.id])).rows[0].auth_user_id,other);
 await db.query('update club_members set auth_user_id=$1 where id=$2',[member,m.id]);
});
test('server denies wrong provider, nonverified identity, and changed email with valid JWT',async()=>{
 await db.exec("select set_config('test.provider','email',false)");assert.equal((await authorize(member)).state,'DOMAIN_DENIED');
 await db.exec("select set_config('test.provider','google',false)");
 await db.query("update auth.identities set identity_data=identity_data || '{\"email_verified\":false}'::jsonb where user_id=$1",[member]);assert.equal((await authorize(member)).state,'DOMAIN_DENIED');
 await db.query("update auth.identities set identity_data=identity_data || '{\"email_verified\":true}'::jsonb where user_id=$1",[member]);
 await db.query("update auth.users set email='member@gmail.com' where id=$1",[member]);assert.equal((await authorize(member)).state,'DOMAIN_DENIED');
 await db.query("update auth.users set email='member@vitstudent.ac.in' where id=$1",[member]);
});
test('before-user hook restricts provider/domain and is not browser callable',async()=>{
 for(const email of ['a@gmail.com','a@vit.ac.in','a@vitstudent.ac.in.fake']) {
 const r=await db.query('select public.before_user_created($1) as r',[JSON.stringify({user:{email,app_metadata:{provider:'google'}}})]);assert.equal(r.rows[0].r.error.http_code,403);
 }
 const valid=await db.query('select public.before_user_created($1) as r',[JSON.stringify({user:{email:'a@vitstudent.ac.in',app_metadata:{provider:'google'}}})]);assert.deepEqual(valid.rows[0].r,{});
 await assert.rejects(as(member,"select public.before_user_created('{}')"),/permission denied/);
});
test('audit history is immutable to authenticated administrators',async()=>{
 for(const sql of ["update membership_audit set event='MEMBER_ADDED'",'delete from membership_audit',"insert into membership_audit(target_membership,event,after_value) select id,'MEMBER_ADDED','{}' from club_members"])
 await assert.rejects(as(admin,sql),/permission denied/);
 assert.ok((await as(admin,'select * from membership_audit')).rows.length>0);
});
