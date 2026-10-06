import { runCleanup } from './cleanup.js';
// Current hosted runtimes inject a JSON dictionary of secret API keys. Fail
// closed on malformed configuration; the legacy key is only for older runtimes
// where the dictionary is absent. Never log dictionary contents or key values.
function privilegedKey(env) {
 const injected = env('SUPABASE_SECRET_KEYS');
 if (injected) {
  let keys;
  try { keys = JSON.parse(injected); } catch { throw new Error('Invalid SUPABASE_SECRET_KEYS configuration'); }
  if (typeof keys?.default !== 'string' || !keys.default.trim()) throw new Error('SUPABASE_SECRET_KEYS.default is missing');
  return keys.default;
 }
 return env('SUPABASE_SERVICE_ROLE_KEY'); // Backwards compatibility only.
}
export function createCleanupHandler({ env, createClient, logger = console }) {
 return async request => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const secret = env('RETENTION_CRON_SECRET');
  if (!secret || request.headers.get('x-retention-secret') !== secret) return new Response('Unauthorized', { status: 401 });
  try {
   let input;
   try { input = await request.json(); } catch { return new Response('Invalid JSON body', { status: 400 }); }
   if (typeof input?.dryRun !== 'boolean') return new Response('dryRun must be true or false', { status: 400 });
   const url = env('SUPABASE_URL'), key = privilegedKey(env);
   if (!url || !key) throw new Error('Server configuration missing');
   const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
   const summary = await runCleanup(client, { dryRun: input.dryRun });
   logger.log(JSON.stringify(summary));
   return Response.json(summary, { status: summary.failures.length ? 503 : 200 });
  } catch (error) {
   logger.error(error instanceof Error ? error.message : 'Cleanup failed');
   return Response.json({ error: 'Retention cleanup failed. Inspect server logs and retry.' }, { status: 500 });
  }
 };
}
