import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {makeDatabase,as,identities} from '../tests/helpers/database.js';
import {runCleanup} from '../supabase/functions/retention-cleanup/cleanup.js';
let db;const {a,admin}=identities;const expired=[],retained=[];
before(async()=>{
 db=await makeDatabase({retention:true});const room=(await db.query('select id from rooms limit 1')).rows[0].id;
 for(const [status,days] of [['COMPLETE',31],['INCOMPLETE',31],['COMPLETE',29],['ACTIVE',40]]) {
  const sid=crypto.randomUUID();(days===31?expired:retained).push(sid);
  await db.query("insert into sessions(id,room_id,member_id,status,started_at,closed_at,closure_reason,closed_by) values($1,$2,$3,$4,now()-($5||' days')::interval,case when $4='ACTIVE' then null else now()-($5||' days')::interval end,case when $4='ACTIVE' then null else 'fixture' end,case when $4='ACTIVE' then null else $3::uuid end)",[sid,room,a,status,String(days)]);
  // Insert fixtures as ACTIVE to respect immutable terminal evidence triggers.
  const pid=crypto.randomUUID(),path=`${a}/${sid}/START/ROOM-${pid}.jpg`;
  await db.exec('alter table session_photos disable trigger freeze_photo');
  await db.query("insert into photo_uploads(id,session_id,auth_user_id,stage,category,storage_path,created_at,expires_at) values($1,$2,$3,'START','ROOM',$4,now()-interval '40 days',now()-interval '39 days')",[pid,sid,a,path]);
  await db.query("insert into session_photos(id,session_id,stage,category,storage_path,mime_type,byte_size,uploaded_by) values($1,$2,'START','ROOM',$3,'image/jpeg',300000,$4)",[pid,sid,path,a]);
  await db.exec('alter table session_photos enable trigger freeze_photo');
  await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata,created_at) values('session-photos',$1,$2,'{\"size\":300000,\"mimetype\":\"image/jpeg\"}',now()-interval '40 days')",[path,a]);
 }
 await db.query("insert into room_key_state(room_id,holder_type,holder_member_id,updated_by,version) values($1,'MEMBER',$2,$2,0)",[room,a]);
 await db.query("insert into key_custody_events(room_id,new_holder,mode,actor_id,operation_id,created_at) values($1,'{\"type\":\"location\",\"id\":\"sw\"}','OUTGOING',$2,$3,now()-interval '31 days')",[room,a,crypto.randomUUID()]);
 for(const [path,hours] of [['old-orphan.jpg',25],['young-orphan.jpg',23]])await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata,created_at) values('session-photos',$1,$2,'{}',now()-($3||' hours')::interval)",[path,a,String(hours)]);
});
after(async()=>db.close());
function client({fail=false}={}) {
 const calls=[];return {calls,rpc:async(name,args={})=>{
  try {const params=name==='retention_plan'?[args.p_dry_run]:name==='retention_ack'?[args.p_paths]:[];
   const result=await db.query(`select public.${name}(${params.map((_,i)=>'$'+(i+1)).join(',')}) as result`,params);return {data:result.rows[0].result,error:null};
  }catch(error){return {data:null,error};}
 },storage:{from:bucket=>({remove:async paths=>{assert.equal(bucket,'session-photos');calls.push(paths);if(fail)return {error:{message:'Storage unavailable'}};
  // Fixture simulates Storage API removing its own metadata after physical success.
  await db.query('delete from storage.objects where bucket_id=$1 and name=any($2)',[bucket,paths]);return {error:null,data:paths};
 }})}};
}
test('dry run identifies terminal >30d and orphan >24h, protects active/young evidence and changes nothing',async()=>{
 const c=client(),summary=await runCleanup(c);const paths=summary.plan.paths.map(p=>p.storage_path);
 assert.equal(summary.plan.expiredSessions,2);assert.ok(paths.includes('old-orphan.jpg'));assert.ok(!paths.includes('young-orphan.jpg'));
 assert.equal(paths.length,3);assert.equal(c.calls.length,0);assert.equal((await db.query('select * from photo_cleanup_queue')).rows.length,0);assert.equal((await db.query('select * from sessions')).rows.length,4);
});
test('ordinary admin/member/anonymous cannot call privileged cleanup RPCs',async()=>{
 for(const actor of [admin,a,null])await assert.rejects(as(db,actor,'select public.retention_plan(false)'),/permission denied/);
});
test('Storage failure retains DB evidence and sessions for safe retry; claiming prevents late draft attachment',async()=>{
 const c=client({fail:true}),result=await runCleanup(c,{dryRun:false});assert.deepEqual(result.failures,['Storage unavailable']);assert.equal((await db.query('select * from sessions')).rows.length,4);
 const uploads=(await db.query('select * from photo_uploads where deleting')).rows;assert.equal(uploads.length,2);
});
test('cleanup removes expired objects through API then DB, retains permanent state and ACTIVE 40d',async()=>{
 const c=client(),result=await runCleanup(c,{dryRun:false});assert.equal(result.database.sessions,2);assert.equal(result.objectsDeleted,3);assert.equal(result.failures.length,0);
 for(const id of expired)assert.equal((await db.query('select * from sessions where id=$1',[id])).rows.length,0);
 for(const id of retained)assert.equal((await db.query('select * from sessions where id=$1',[id])).rows.length,1);
 assert.equal((await db.query('select * from room_key_state')).rows.length,1);assert.equal((await db.query('select * from club_members')).rows.length,3);assert.equal((await db.query('select * from membership_audit')).rows.length,3);
 assert.equal((await db.query('select * from key_custody_events')).rows.length,0);assert.equal((await db.query("select * from storage.objects where name='young-orphan.jpg'")).rows.length,1);
});
test('repeating cleanup is idempotent',async()=>{const c=client(),result=await runCleanup(c,{dryRun:false});assert.equal(result.objectsDeleted,0);assert.equal(result.database.sessions,0);assert.equal(c.calls.length,0);});

test('Edge handler denies JWT-only calls, requires explicit dry run, and never initializes privileged client for invalid requests',async()=>{
 const {createCleanupHandler}=await import('../supabase/functions/retention-cleanup/handler.js');
 let initialized=0;const handler=createCleanupHandler({env:name=>({RETENTION_CRON_SECRET:'fixture-server-only-secret',SUPABASE_URL:'https://fixture',SUPABASE_SERVICE_ROLE_KEY:'server-fixture-key'})[name],createClient:()=>{initialized++;return client();},logger:{log(){},error(){}}});
 const request=(headers,body='{"dryRun":true}')=>new Request('https://fixture/retention-cleanup',{method:'POST',headers:{'Content-Type':'application/json',...headers},body});
 assert.equal((await handler(request({Authorization:'Bearer user-jwt'}))).status,401);
 assert.equal((await handler(request({'x-retention-secret':'wrong'}))).status,401);
 assert.equal((await handler(request({'x-retention-secret':'fixture-server-only-secret'},'{}'))).status,400);assert.equal(initialized,0);
 const valid=await handler(request({'x-retention-secret':'fixture-server-only-secret'}));assert.equal(valid.status,200);assert.equal(initialized,1);assert.equal((await valid.json()).dryRun,true);
});
