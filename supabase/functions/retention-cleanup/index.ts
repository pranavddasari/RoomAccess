import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { createCleanupHandler } from './handler.js';
// Cron's server-only secret is checked by the handler; app JWTs cannot invoke it.
Deno.serve(createCleanupHandler({ env: (name: string) => Deno.env.get(name), createClient }));
