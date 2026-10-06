import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCleanupHandler } from '../supabase/functions/retention-cleanup/handler.js';
import { runCleanup } from '../supabase/functions/retention-cleanup/cleanup.js';
const injectedKey = 'sb_secret_fixture_only';
const legacyKey = 'legacy_fixture_only';
function handlerFixture(configuration) {
 const initialized = [], logs = [];
 const handler = createCleanupHandler({
  env: name => ({ RETENTION_CRON_SECRET: 'cron-fixture', SUPABASE_URL: 'https://fixture', ...configuration })[name],
  createClient: (url, key, options) => {
   initialized.push({ url, key, options });
   return { rpc: async (name, args) => {
    assert.equal(name, 'retention_plan'); assert.deepEqual(args, { p_dry_run: true });
    return { data: { paths: [] }, error: null };
   } };
  },
  logger: { log: message => logs.push(message), error: message => logs.push(message) },
 });
 const invoke = () => handler(new Request('https://fixture/retention-cleanup', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-retention-secret': 'cron-fixture' }, body: '{"dryRun":true}',
 }));
 return { invoke, initialized, logs };
}
test('Edge uses injected SUPABASE_SECRET_KEYS.default before the legacy key and never logs either key', async () => {
 const fixture = handlerFixture({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: injectedKey, another: 'unused-fixture' }), SUPABASE_SERVICE_ROLE_KEY: legacyKey });
 assert.equal((await fixture.invoke()).status, 200);
 assert.deepEqual(fixture.initialized, [{ url: 'https://fixture', key: injectedKey, options: { auth: { persistSession: false, autoRefreshToken: false } } }]);
 assert.ok(!fixture.logs.join('').includes(injectedKey)); assert.ok(!fixture.logs.join('').includes(legacyKey));
});
test('Edge legacy service-role fallback works only when injected secret dictionary is absent', async () => {
 const fixture = handlerFixture({ SUPABASE_SERVICE_ROLE_KEY: legacyKey });
 assert.equal((await fixture.invoke()).status, 200);
 assert.equal(fixture.initialized[0].key, legacyKey);
});
test('malformed/missing default injected secrets fail closed without leaking contents or falling back', async () => {
 for (const configuration of [injectedKey, JSON.stringify({ alternate: injectedKey }), JSON.stringify({ default: null }), JSON.stringify({ default: ' ' })]) {
  const fixture = handlerFixture({ SUPABASE_SECRET_KEYS: configuration, SUPABASE_SERVICE_ROLE_KEY: legacyKey });
  const response = await fixture.invoke();
  assert.equal(response.status, 500); assert.equal(fixture.initialized.length, 0);
  assert.ok(!fixture.logs.join('').includes(injectedKey));
  assert.ok(!(await response.text()).includes(injectedKey));
 }
 const missing = handlerFixture({}); assert.equal((await missing.invoke()).status, 500); assert.equal(missing.initialized.length, 0);
});
test('cleanup dry run invokes only planning, never Storage, acknowledgement or finalization', async () => {
 const calls = [];
 const summary = await runCleanup({ rpc: async (name, args) => {
  calls.push({ name, args }); return { data: { paths: [{ storage_path: 'fixture.jpg' }] }, error: null };
 } });
 assert.deepEqual(calls, [{ name: 'retention_plan', args: { p_dry_run: true } }]);
 assert.equal(summary.objectsDeleted, 0); assert.equal(summary.dryRun, true);
});
test('Storage removal precedes acknowledgement; failed acknowledgement leaves a retryable, idempotent batch', async () => {
 const calls = [];
 let acknowledged = false, failAck = true, physicalPresent = true;
 const client = {
  rpc: async (name, args) => {
   calls.push(name);
   if (name === 'retention_plan') return { data: { paths: acknowledged ? [] : [{ storage_path: 'fixture.jpg' }] }, error: null };
   if (name === 'retention_ack') {
    assert.equal(physicalPresent, false); assert.deepEqual(args.p_paths, ['fixture.jpg']);
    if (failAck) { failAck = false; return { error: new Error('Temporary database failure') }; }
    acknowledged = true; return { data: null, error: null };
   }
   assert.equal(name, 'retention_finalize'); assert.equal(acknowledged, true);
   return { data: { sessions: 1 }, error: null };
  },
  storage: { from: bucket => ({ remove: async paths => {
   assert.equal(bucket, 'session-photos'); assert.deepEqual(paths, ['fixture.jpg']);
   calls.push('remove'); physicalPresent = false; return { data: [], error: null };
  } }) },
 };
 await assert.rejects(runCleanup(client, { dryRun: false }), /Temporary database failure/);
 assert.equal(acknowledged, false);
 assert.deepEqual(calls, ['retention_plan', 'remove', 'retention_ack']);
 calls.length = 0;
 const retried = await runCleanup(client, { dryRun: false });
 assert.deepEqual(calls, ['retention_plan', 'remove', 'retention_ack', 'retention_plan', 'retention_finalize']);
 assert.equal(retried.objectsDeleted, 1); assert.equal(retried.database.sessions, 1);
 calls.length = 0;
 const repeated = await runCleanup(client, { dryRun: false });
 assert.equal(repeated.objectsDeleted, 0); assert.deepEqual(calls, ['retention_plan', 'retention_finalize']);
});
