import { runCleanup } from './cleanup.js';
export function createCleanupHandler({ env, createClient, logger = console }) {
 return async request => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const secret = env('RETENTION_CRON_SECRET');
  if (!secret || request.headers.get('x-retention-secret') !== secret) return new Response('Unauthorized', { status: 401 });
  try {
   let input;
   try { input = await request.json(); } catch { return new Response('Invalid JSON body', { status: 400 }); }
   if (typeof input?.dryRun !== 'boolean') return new Response('dryRun must be true or false', { status: 400 });
   const url = env('SUPABASE_URL'), key = env('SUPABASE_SERVICE_ROLE_KEY');
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
