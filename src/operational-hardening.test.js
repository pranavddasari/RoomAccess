import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeDatabase, as, command, photo, holder, sw, mho, identities } from '../tests/helpers/database.js';
const { admin, a, b, unknown } = identities;
const preauthorized = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const disabled = 'deadbeef-dead-4bee-8bad-deadbeefdead';
let db, rooms;
before(async () => {
 db = await makeDatabase();
 rooms = (await db.query('select id from rooms order by display_name')).rows.map(row => row.id);
 await db.query("insert into club_members(id,name,email,status) values($1,'Preauthorized','preauthorized@vitstudent.ac.in','ACTIVE'),($2,'Disabled','disabled@vitstudent.ac.in','DISABLED')", [preauthorized, disabled]);
});
after(async () => db.close());
const correct = (room, destination) => command(db, admin, 'CORRECT', room, { payload: { destination, reason: 'Physically verified' } });
async function startWithEndEvidence(room) {
 await correct(room, holder(a));
 const session = crypto.randomUUID();
 const roomPhoto = await photo(db, a, session, 'START', 'ROOM');
 const cablesPhoto = await photo(db, a, session, 'START', 'CABLES');
 await command(db, a, 'START', room, { session, payload: { roomPhoto, cablesPhoto } });
 for (const category of ['ROOM', 'CABLES']) {
  await command(db, a, 'END_PHOTO', room, { session, payload: await photo(db, a, session, 'END', category) });
 }
 return session;
}
const custody = async operation => (await db.query('select * from key_custody_events where operation_id=$1', [operation])).rows[0];
const request = async operation => (await db.query('select request from processed_operations where operation_id=$1', [operation])).rows[0].request;

test('directory includes ACTIVE linked and preauthorized members, excludes DISABLED, and preserves caller authorization', async () => {
 const members = (await as(db, a, 'select * from operational_directory()')).rows;
 assert.ok(members.some(row => row.id === a));
 assert.ok(members.some(row => row.id === preauthorized));
 assert.equal((await db.query('select auth_user_id from club_members where id=$1', [preauthorized])).rows[0].auth_user_id, null);
 assert.ok(!members.some(row => row.id === disabled));
 assert.equal((await as(db, unknown, 'select * from operational_directory()')).rows.length, 0);
 await assert.rejects(as(db, null, 'select * from operational_directory()'), /permission denied/);
});

test('member source extras compare equal and only canonical source/previous/new holder facts are stored', async () => {
 await correct(rooms[0], holder(a));
 const operation = crypto.randomUUID();
 await command(db, b, 'RECEIVE', rooms[0], { operation, payload: { source: { ...holder(a), name: 'Some Name', untrusted: { role: 'ADMIN' } } } });
 const event = await custody(operation);
 assert.deepEqual(event.previous_recorded_holder, holder(a));
 assert.deepEqual(event.reported_source, holder(a));
 assert.deepEqual(event.new_holder, holder(b));
 assert.equal(event.mismatch, false);
 assert.equal((await db.query("select * from flags where room_id=$1 and type='KEY_CUSTODY_MISMATCH'", [rooms[0]])).rows.length, 0);
 assert.deepEqual((await request(operation)).payload.source, holder(a));
 const details = (await db.query("select details from operational_audit where operation_id=$1 and event='KEY_CUSTODY_RECORDED'", [operation])).rows[0].details;
 assert.deepEqual(details, { previousRecordedHolder: holder(a), reportedSource: holder(a), newHolder: holder(b) });
});

test('TRANSFER canonicalizes member UUID spelling and accepts ACTIVE recipients without an Auth link', async () => {
 const operation = crypto.randomUUID();
 await command(db, b, 'TRANSFER', rooms[0], { operation, payload: { destination: { type: 'member', id: preauthorized.toUpperCase(), name: 'Preauthorized', extra: true } } });
 assert.deepEqual((await custody(operation)).new_holder, holder(preauthorized));
 assert.deepEqual((await request(operation)).payload.destination, holder(preauthorized));
 assert.equal((await db.query('select holder_member_id from room_key_state where room_id=$1', [rooms[0]])).rows[0].holder_member_id, preauthorized);
 const incoming = crypto.randomUUID();
 await command(db, a, 'RECEIVE', rooms[0], { operation: incoming, payload: { source: { type: 'member', id: preauthorized.toUpperCase(), name: 'Other display name' } } });
 assert.equal((await custody(incoming)).mismatch, false);
 assert.deepEqual((await custody(incoming)).reported_source, holder(preauthorized));
});

test('location destination/source extras are discarded for both SW and MHO', async () => {
 for (const destination of [sw, mho]) {
  const outgoing = crypto.randomUUID();
  await command(db, a, 'TRANSFER', rooms[0], { operation: outgoing, payload: { destination: { ...destination, name: 'Office', arbitrary: [1, 2] } } });
  assert.deepEqual((await custody(outgoing)).new_holder, destination);
  const incoming = crypto.randomUUID();
  await command(db, a, 'RECEIVE', rooms[0], { operation: incoming, payload: { source: { ...destination, name: 'Office' } } });
  assert.deepEqual((await custody(incoming)).reported_source, destination);
  assert.equal((await custody(incoming)).mismatch, false);
 }
});

test('CORRECT to the canonical same ACTIVE owner keeps the session ACTIVE and stores clean audit facts', async () => {
 const session = await startWithEndEvidence(rooms[1]);
 const operation = crypto.randomUUID();
 await command(db, admin, 'CORRECT', rooms[1], { session, operation, payload: { destination: { ...holder(a), name: 'Display label' }, reason: 'Rechecked holder', source: { name: 'Unused browser field' } } });
 assert.equal((await db.query('select status from sessions where id=$1', [session])).rows[0].status, 'ACTIVE');
 assert.deepEqual((await custody(operation)).new_holder, holder(a));
 const audit = (await db.query("select details from operational_audit where operation_id=$1 and event='ADMIN_CORRECTION'", [operation])).rows[0].details;
 assert.deepEqual(audit, { destination: holder(a), reason: 'Rechecked holder' });
 await command(db, a, 'END', rooms[1], { session, payload: { destination: { type: 'retain', name: 'Unused label', id: 'untrusted' } } });
 assert.deepEqual((await db.query('select key_disposition from sessions where id=$1', [session])).rows[0].key_disposition, { type: 'retain' });
 assert.equal((await db.query("select * from key_custody_events where session_id=$1 and mode='SESSION_CHECKOUT'", [session])).rows.length, 0);
});

test('normal checkout persists canonical member/location dispositions, events, and audit details', async () => {
 for (const destination of [holder(b), sw, mho]) {
  const session = await startWithEndEvidence(rooms[2]);
  const operation = crypto.randomUUID();
  await command(db, a, 'END', rooms[2], { session, operation, payload: { destination: { ...destination, name: 'Browser display label', ignored: true } } });
  const row = (await db.query('select status,key_disposition from sessions where id=$1', [session])).rows[0];
  assert.equal(row.status, 'COMPLETE');
  assert.deepEqual(row.key_disposition, destination);
  assert.deepEqual((await custody(operation)).previous_recorded_holder, holder(a));
  assert.deepEqual((await custody(operation)).new_holder, destination);
  const audit = (await db.query("select details from operational_audit where operation_id=$1 and event='SESSION_CLOSED'", [operation])).rows[0].details;
  assert.deepEqual(audit.keyDisposition, destination);
 }
});

test('invalid, nonexistent, DISABLED and self holders remain rejected without state changes; helper is private', async () => {
 await correct(rooms[3], holder(a));
 const version = (await db.query('select version from rooms where id=$1', [rooms[3]])).rows[0].version;
 for (const destination of [null, [], 'member', {}, { type: 'member', id: 123 }, { type: 'member', id: 'invalid-uuid' }, holder(unknown), holder(disabled), { type: 'location', id: 'elsewhere' }, { type: 'location', id: 'SW' }]) {
  await assert.rejects(command(db, a, 'TRANSFER', rooms[3], { payload: { destination } }), /valid key holder|active club member/);
  await assert.rejects(correct(rooms[3], destination), /valid key holder|active club member/);
  await assert.rejects(command(db, b, 'RECEIVE', rooms[3], { payload: { source: destination } }), /valid key holder|active club member/);
 }
 await assert.rejects(command(db, a, 'TRANSFER', rooms[3], { payload: { destination: { ...holder(a), name: 'Self' } } }), /yourself/);
 await assert.rejects(command(db, b, 'RECEIVE', rooms[3], { payload: { source: holder(b) } }), /yourself/);
 assert.equal((await db.query('select version from rooms where id=$1', [rooms[3]])).rows[0].version, version);
 await assert.rejects(as(db, a, 'select private.canonical_holder($1,$2,false,false)', [JSON.stringify(holder(disabled)), a]), /permission denied/);
});

test('canonical retries preserve idempotency, legacy fingerprints and later-disabled targets without allowing new transfers', async () => {
 const recipient = crypto.randomUUID();
 await db.query("insert into club_members(id,name,email) values($1,'Retry recipient','retry@vitstudent.ac.in')", [recipient]);
 await correct(rooms[4], holder(a));
 const operation = crypto.randomUUID();
 const version = (await db.query('select version from rooms where id=$1', [rooms[4]])).rows[0].version;
 const first = await command(db, a, 'TRANSFER', rooms[4], { operation, version, payload: { destination: { ...holder(recipient), name: 'Browser name' } } });
 await correct(rooms[4], sw);
 await as(db, admin, "select change_club_member($1,null,'DISABLED')", [recipient]);
 // A pre-hardening retry fingerprint may still contain display fields.
 await db.query("update processed_operations set request=jsonb_set(request,'{payload,destination,name}','\"Legacy display name\"') where operation_id=$1", [operation]);
 const second = await command(db, a, 'TRANSFER', rooms[4], { operation, version, payload: { destination: holder(recipient) } });
 assert.deepEqual(second, first);
 assert.equal((await db.query('select * from key_custody_events where operation_id=$1', [operation])).rows.length, 1);
 await correct(rooms[4], holder(a));
 await assert.rejects(command(db, a, 'TRANSFER', rooms[4], { payload: { destination: holder(recipient) } }), /active club member/);
 await assert.rejects(command(db, a, 'TRANSFER', rooms[4], { operation, version, payload: { destination: sw } }), /conflicts/);
 await assert.rejects(command(db, b, 'TRANSFER', rooms[4], { operation, version, payload: { destination: holder(recipient) } }), /conflicts/);
});
