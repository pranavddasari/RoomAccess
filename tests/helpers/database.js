import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
export const identities = { admin:'11111111-1111-4111-8111-111111111111', a:'22222222-2222-4222-8222-222222222222', b:'33333333-3333-4333-8333-333333333333', unknown:'44444444-4444-4444-8444-444444444444' };
export async function makeDatabase({ retention=false }={}) {
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role supabase_auth_admin; create role service_role bypassrls;
 create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql as $$select jsonb_build_object('app_metadata',jsonb_build_object('provider',coalesce(nullif(current_setting('test.provider',true),''),'google')))$$;
 grant usage on schema auth to authenticated; grant execute on all functions in schema auth to authenticated;
 create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text unique,owner_id text,metadata jsonb,created_at timestamptz default now());
 alter table storage.objects enable row level security; grant usage on schema storage to authenticated; grant insert,select on storage.objects to authenticated;`);
 for(const file of ['202610050001_membership.sql','202610060001_operations.sql',...(retention?['202610060002_retention.sql']:[]),'202610060003_operational_hardening.sql'])await db.exec(await readFile(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'));
 for(const [name,id] of Object.entries(identities)){
  await db.query('insert into auth.users values($1,$2,now())',[id,`${name}@vitstudent.ac.in`]);
  await db.query("insert into auth.identities values($1,'google',$2)",[id,JSON.stringify({email:`${name}@vitstudent.ac.in`,email_verified:true})]);
  if(name!=='unknown')await db.query('insert into club_members(id,name,email,role,auth_user_id) values($1,$2,$3,$4,$1)',[id,name,`${name}@vitstudent.ac.in`,name==='admin'?'ADMIN':'MEMBER']);
 }
 return db;
}
export async function as(db,actor,sql,args=[]){await db.exec('reset role');await db.query("select set_config('test.uid',$1,false)",[actor??'']);await db.exec(actor?'set role authenticated':'set role anon');try{return await db.query(sql,args);}finally{await db.exec('reset role');}}
export async function command(db,actor,action,room,{session=null,payload={},version,operation=crypto.randomUUID()}={}){
 if(version===undefined)version=(await db.query('select version from rooms where id=$1',[room])).rows[0].version;
 return (await as(db,actor,'select public.operational_command($1,$2,$3,$4,$5,$6) as result',[operation,action,room,version,session,JSON.stringify(payload)])).rows[0].result;
}
export async function photo(db,actor,session,stage,category){
 const id=crypto.randomUUID();const path=(await as(db,actor,'select public.register_photo_upload($1,$2,$3,$4) as path',[id,session,stage,category])).rows[0].path;
 await as(db,actor,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('session-photos',$1,$2,'{\"size\":300000,\"mimetype\":\"image/jpeg\"}')",[path,actor]);
 return {id,width:1200,height:900,category};
}
export const holder=(id)=>({type:'member',id});
export const sw={type:'location',id:'sw'},mho={type:'location',id:'mho'};
