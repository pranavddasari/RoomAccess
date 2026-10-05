import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { makeDatabase,as,command,photo,holder,sw,mho,identities } from '../tests/helpers/database.js';
const {admin,a,b,unknown}=identities; let db,rooms; const sessions={};
before(async()=>{db=await makeDatabase();rooms=(await db.query('select id from rooms order by display_name')).rows.map(r=>r.id);});
after(async()=>db.close());
const initialize=(room,destination=holder(a))=>command(db,admin,'CORRECT',room,{payload:{destination,reason:'Physically verified'}});
async function start(actor,room){const session=crypto.randomUUID(); const roomPhoto=await photo(db,actor,session,'START','ROOM'),cablesPhoto=await photo(db,actor,session,'START','CABLES');await command(db,actor,'START',room,{session,payload:{roomPhoto,cablesPhoto}});return session;}
async function endPhoto(actor,room,session,category){return command(db,actor,'END_PHOTO',room,{session,payload:await photo(db,actor,session,'END',category)});}
test('five placeholder rooms seed without inventing key custody; start and receipt require initialization',async()=>{
 assert.equal(rooms.length,5);assert.equal((await db.query('select * from room_key_state')).rows.length,0);
 await assert.rejects(command(db,a,'START',rooms[0],{session:crypto.randomUUID()}),/not initialized/);
 await assert.rejects(command(db,a,'RECEIVE',rooms[0],{payload:{source:sw}}),/not initialized/);
 await assert.rejects(initialize(rooms[0],holder(unknown)),/active club member/);
 await initialize(rooms[0]);await initialize(rooms[1]);
});
test('only holder starts; both owned valid photos required; same member can start two different rooms',async()=>{
 await assert.rejects(command(db,b,'START',rooms[0],{session:crypto.randomUUID()}),/must hold/);
 await assert.rejects(command(db,a,'START',rooms[0],{session:crypto.randomUUID()}),/photo draft/);
 assert.equal((await db.query('select * from sessions')).rows.length,0);
 sessions.first=await start(a,rooms[0]);sessions.second=await start(a,rooms[1]);
 assert.equal((await db.query("select * from sessions where status='ACTIVE' and member_id=$1",[a])).rows.length,2);
 await assert.rejects(command(db,a,'START',rooms[0],{session:crypto.randomUUID()}),/already has an active/);
 await assert.rejects(db.query("insert into sessions(id,room_id,member_id,status) values($1,$2,$3,'ACTIVE')",[crypto.randomUUID(),rooms[0],a]),/unique/);
});
test('end requires both photos; partial END evidence survives another member recovery in only one room',async()=>{
 await endPhoto(a,rooms[0],sessions.first,'ROOM');
 await assert.rejects(command(db,a,'END',rooms[0],{session:sessions.first,payload:{destination:{type:'retain'}}}),/Both accepted end/);
 await assert.rejects(command(db,b,'RECEIVE',rooms[0],{payload:{source:sw,recoveryReason:'OTHER'}}),/Other requires remarks/);
 await command(db,b,'RECEIVE',rooms[0],{session:sessions.first,payload:{source:sw,recoveryReason:'OTHER',recoveryRemarks:'Received from office after previous band left'}});
 const s=(await db.query('select * from sessions where id=$1',[sessions.first])).rows[0];assert.equal(s.status,'INCOMPLETE');assert.equal(s.closed_by,b);assert.equal(s.recovery_remarks,'Received from office after previous band left');
 assert.equal((await db.query("select * from session_photos where session_id=$1 and stage='END'",[s.id])).rows.length,1);
 assert.equal((await db.query('select status from sessions where id=$1',[sessions.second])).rows[0].status,'ACTIVE');
 const e=(await db.query("select * from key_custody_events where mode='INCOMING'")).rows[0];assert.deepEqual(e.previous_recorded_holder,holder(a));assert.deepEqual(e.reported_source,sw);assert.deepEqual(e.new_holder,holder(b));assert.equal(e.mismatch,true);
 assert.equal((await db.query('select * from flags where room_id=$1',[rooms[0]])).rows.length,2);
 assert.equal((await db.query("select * from sessions where room_id=$1 and status='ACTIVE'",[rooms[0]])).rows.length,0);
});
test('terminal outcome and evidence cannot be repaired; late checkout, upload, replacement rejected',async()=>{
 await assert.rejects(command(db,a,'END',rooms[0],{session:sessions.first,payload:{destination:{type:'retain'}}}),/exact active session owner/);
 await assert.rejects(photo(db,a,sessions.first,'END','CABLES'),/active session owner/);
 await assert.rejects(db.query("update sessions set status='COMPLETE' where id=$1",[sessions.first]),/Terminal sessions/);
 await assert.rejects(db.query('update session_photos set byte_size=1 where session_id=$1',[sessions.first]),/Terminal evidence/);
});
test('normal checkout retaining key closes COMPLETE with no self-transfer; end evidence replaces while active',async()=>{
 const count=(await db.query('select count(*)::int as n from key_custody_events where room_id=$1',[rooms[1]])).rows[0].n;
 await endPhoto(a,rooms[1],sessions.second,'ROOM');await endPhoto(a,rooms[1],sessions.second,'ROOM');await endPhoto(a,rooms[1],sessions.second,'CABLES');
 assert.equal((await db.query("select * from session_photos where session_id=$1 and stage='END'",[sessions.second])).rows.length,2);
 await command(db,a,'END',rooms[1],{session:sessions.second,payload:{destination:{type:'retain'}}});
 assert.equal((await db.query('select status from sessions where id=$1',[sessions.second])).rows[0].status,'COMPLETE');
 assert.equal((await db.query('select count(*)::int as n from key_custody_events where room_id=$1',[rooms[1]])).rows[0].n,count);
 assert.equal((await db.query('select holder_member_id from room_key_state where room_id=$1',[rooms[1]])).rows[0].holder_member_id,a);
});
test('idle outgoing transfer verifies holder, recipient and version; incoming receipt preserves correct source',async()=>{
 await assert.rejects(command(db,b,'TRANSFER',rooms[1],{payload:{destination:sw}}),/Only the recorded holder/);
 await assert.rejects(command(db,a,'TRANSFER',rooms[1],{payload:{destination:holder(a)}}),/yourself/);
 await assert.rejects(command(db,a,'TRANSFER',rooms[1],{payload:{destination:holder(unknown)}}),/active club member/);
 await command(db,a,'TRANSFER',rooms[1],{payload:{destination:holder(b)}});
 const version=(await db.query('select version from rooms where id=$1',[rooms[1]])).rows[0].version;
 await command(db,b,'TRANSFER',rooms[1],{payload:{destination:mho}});
 await assert.rejects(command(db,b,'RECEIVE',rooms[1],{version,payload:{source:mho}}),/state changed/);
 await command(db,a,'RECEIVE',rooms[1],{payload:{source:mho}});
 const latest=(await db.query("select * from key_custody_events where room_id=$1 order by created_at desc",[rooms[1]])).rows[0];assert.equal(latest.mismatch,false);assert.deepEqual(latest.reported_source,mho);
 await command(db,a,'TRANSFER',rooms[1],{payload:{destination:sw}});
});
test('self reported incomplete retains key; new sessions remain possible; active transfers rejected',async()=>{
 await initialize(rooms[2]);sessions.self=await start(a,rooms[2]);
 await assert.rejects(command(db,a,'TRANSFER',rooms[2],{payload:{destination:sw}}),/Check out or recover/);
 await command(db,a,'SELF_RECOVER',rooms[2],{session:sessions.self});
 assert.equal((await db.query('select status from sessions where id=$1',[sessions.self])).rows[0].status,'INCOMPLETE');
 assert.equal((await db.query('select holder_member_id from room_key_state where room_id=$1',[rooms[2]])).rows[0].holder_member_id,a);
 sessions.next=await start(a,rooms[2]);
});
test('admin flag resolution preserves incomplete session and requires ADMIN',async()=>{
 const flag=(await db.query("select * from flags where type='MISSING_END_CHECKOUT' limit 1")).rows[0];
 await assert.rejects(command(db,a,'RESOLVE_FLAG',flag.room_id,{payload:{flagId:flag.id,note:'reviewed'}}),/Administrator/);
 await command(db,admin,'RESOLVE_FLAG',flag.room_id,{payload:{flagId:flag.id,note:'reviewed'}});
 assert.equal((await db.query('select status from sessions where id=$1',[flag.session_id])).rows[0].status,'INCOMPLETE');
 assert.equal((await db.query('select status from flags where id=$1',[flag.id])).rows[0].status,'RESOLVED');
});
test('admin correction appends events and closes incompatible active session without rewriting previous history',async()=>{
 const before=(await db.query('select * from key_custody_events order by id')).rows;
 await assert.rejects(command(db,a,'CORRECT',rooms[2],{payload:{destination:sw,reason:'verified'}}),/Administrator/);
 await command(db,admin,'CORRECT',rooms[2],{session:sessions.next,payload:{destination:sw,reason:'Verified in SW office'}});
 assert.equal((await db.query('select status from sessions where id=$1',[sessions.next])).rows[0].status,'INCOMPLETE');
 const after=(await db.query('select * from key_custody_events order by id')).rows;for(const event of before)assert.deepEqual(after.find(e=>e.id===event.id),event);
 assert.ok((await db.query("select * from operational_audit where event='ADMIN_CORRECTION'")).rows.length>0);
});
test('idempotent retry returns original result; changed payload, reused operation and stale modal fail',async()=>{
 const operation=crypto.randomUUID(),version=(await db.query('select version from rooms where id=$1',[rooms[2]])).rows[0].version;
 const payload={source:sw};const first=await command(db,a,'RECEIVE',rooms[2],{operation,version,payload});const second=await command(db,a,'RECEIVE',rooms[2],{operation,version,payload});assert.deepEqual(first,second);
 assert.equal((await db.query('select * from key_custody_events where operation_id=$1',[operation])).rows.length,1);
 await assert.rejects(command(db,b,'RECEIVE',rooms[2],{operation,version,payload}),/conflicts/);
 await assert.rejects(command(db,a,'TRANSFER',rooms[2],{version,payload:{destination:sw}}),/state changed/);
});
test('disabling a holder or active session owner fails; membership and last-admin safeguards remain intact',async()=>{
 await assert.rejects(as(db,admin,"select public.change_club_member($1,null,'DISABLED')",[a]),/Resolve this member/);
 await initialize(rooms[2],sw);await initialize(rooms[0],sw);
 await as(db,admin,"select public.change_club_member($1,null,'DISABLED')",[b]);
 await assert.rejects(command(db,b,'RECEIVE',rooms[0],{payload:{source:sw}}),/Active membership/);
 assert.equal((await as(db,b,'select * from rooms')).rows.length,0);
 await assert.rejects(as(db,admin,"select public.change_club_member($1,'MEMBER',null)",[admin]),/active administrator/);
});
test('RLS denies unknown/invalid/disabled/anonymous reads and direct mutations; members see own history only',async()=>{
 for(const actor of [unknown,b])for(const table of ['rooms','sessions','session_photos','operational_audit'])assert.equal((await as(db,actor,`select * from ${table}`)).rows.length,0);
 await assert.rejects(as(db,null,'select * from rooms'),/permission denied/);
 await assert.rejects(as(db,a,"update room_key_state set holder_type='SW'"),/permission denied/);
 await assert.rejects(as(db,admin,'delete from operational_audit'),/permission denied/);
 const memberRows=(await as(db,a,"select * from sessions where status<>'ACTIVE'")).rows;assert.ok(memberRows.every(s=>s.member_id===a));
 await db.exec("select set_config('test.provider','email',false)");assert.equal((await as(db,a,'select * from rooms')).rows.length,0);await db.exec("select set_config('test.provider','google',false)");
});
test('Storage upload namespaces, private bucket, verified object ownership and owner/admin evidence reads',async()=>{
 const bucket=(await db.query("select * from storage.buckets where id='session-photos'")).rows[0];assert.equal(bucket.public,false);assert.equal(bucket.file_size_limit,512000);
 const id=crypto.randomUUID(),sid=crypto.randomUUID();const path=(await as(db,a,"select register_photo_upload($1,$2,'START','ROOM') as p",[id,sid])).rows[0].p;
 await assert.rejects(as(db,admin,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('session-photos',$1,$2,'{}')",[path,admin]),/row-level security/);
 await assert.rejects(as(db,unknown,"select register_photo_upload($1,$2,'START','ROOM')",[crypto.randomUUID(),sid]),/Active membership/);
 const visible=(await as(db,a,'select * from storage.objects')).rows;assert.ok(visible.length>0);
 const all=(await as(db,admin,'select * from storage.objects')).rows;assert.ok(all.length>=visible.length);
 await assert.rejects(as(db,a,'delete from storage.objects'),/permission denied/);
 // Fresh drafts have no read permission until evidence is attached.
 assert.equal(visible.some(o=>o.name===path),false);
});

test('disable guard also catches an ACTIVE session independently of recorded custody',async()=>{
 const sid=crypto.randomUUID();await db.query("insert into sessions(id,room_id,member_id,status) values($1,$2,$3,'ACTIVE')",[sid,rooms[4],a]);
 // Trusted fixture creates the mismatch; public commands never create it.
 await assert.rejects(as(db,admin,"select public.change_club_member($1,null,'DISABLED')",[a]),/Resolve this member/);
 await db.query("update sessions set status='INCOMPLETE',closed_at=now(),closure_reason='fixture recovery',closed_by=$2 where id=$1",[sid,admin]);
});
test('checkout can transfer to member or office atomically; disabled recipients are rejected',async()=>{
 await initialize(rooms[3]);let session=await start(a,rooms[3]);await endPhoto(a,rooms[3],session,'ROOM');await endPhoto(a,rooms[3],session,'CABLES');
 await assert.rejects(command(db,a,'END',rooms[3],{session,payload:{destination:holder(b)}}),/active club member/);
 await command(db,a,'END',rooms[3],{session,payload:{destination:holder(admin)}});
 assert.equal((await db.query('select holder_member_id from room_key_state where room_id=$1',[rooms[3]])).rows[0].holder_member_id,admin);
 await initialize(rooms[3]);session=await start(a,rooms[3]);await endPhoto(a,rooms[3],session,'ROOM');await endPhoto(a,rooms[3],session,'CABLES');await command(db,a,'END',rooms[3],{session,payload:{destination:mho}});
 assert.equal((await db.query('select holder_type from room_key_state where room_id=$1',[rooms[3]])).rows[0].holder_type,'MHO');
});
test('Storage denies other active member evidence and rejects foreign or oversize photo objects on attachment',async()=>{
 // Re-enable b; access denial here must come from ownership, not disabled status.
 await as(db,admin,"select public.change_club_member($1,null,'ACTIVE')",[b]);
 assert.equal((await as(db,b,'select * from storage.objects')).rows.length,0);
 assert.equal((await as(db,b,"select * from sessions where status<>'ACTIVE'")).rows.length,0);
 const sid=crypto.randomUUID(),roomPhoto=await photo(db,a,sid,'START','ROOM'),cablesPhoto=await photo(db,a,sid,'START','CABLES');
 await initialize(rooms[4]);
 await db.query("update storage.objects set owner_id=$1 where name=(select storage_path from photo_uploads where id=$2)",[b,roomPhoto.id]);
 await assert.rejects(command(db,a,'START',rooms[4],{session:sid,payload:{roomPhoto,cablesPhoto}}),/valid private uploaded photo/);
 await db.query("update storage.objects set owner_id=$1,metadata='{\"size\":600000,\"mimetype\":\"image/jpeg\"}' where name=(select storage_path from photo_uploads where id=$2)",[a,roomPhoto.id]);
 await assert.rejects(command(db,a,'START',rooms[4],{session:sid,payload:{roomPhoto,cablesPhoto}}),/valid private uploaded photo/);
 assert.equal((await db.query('select * from sessions where id=$1',[sid])).rows.length,0);
});

test('invalid verified email and unknown membership cannot read snapshots or operate even with a claimed actor in payload',async()=>{
 await assert.rejects(command(db,unknown,'RECEIVE',rooms[0],{payload:{source:sw,actorId:admin}}),/Active membership/);
 await db.query("update auth.users set email='a@gmail.com' where id=$1",[a]);
 assert.equal((await as(db,a,'select * from room_key_state')).rows.length,0);
 await assert.rejects(command(db,a,'RECEIVE',rooms[0],{payload:{source:sw,actorId:admin}}),/Active membership/);
 await db.query("update auth.users set email='a@vitstudent.ac.in' where id=$1",[a]);
});

test('restrictive Storage guards withstand broad pre-existing policies without exposing this bucket',async()=>{
 await db.exec('create policy fixture_broad_storage on storage.objects for all to public using(true) with check(true); grant usage on schema storage to anon; grant select on storage.objects to anon;');
 assert.equal((await as(db,b,'select * from storage.objects')).rows.length,0);
 assert.equal((await as(db,null,'select * from storage.objects')).rows.length,0);
 const id=crypto.randomUUID(),sid=crypto.randomUUID(),path=(await as(db,a,"select register_photo_upload($1,$2,'START','ROOM') as p",[id,sid])).rows[0].p;
 await assert.rejects(as(db,b,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('session-photos',$1,$2,'{}')",[path,b]),/row-level security/);
});
