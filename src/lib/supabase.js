import { createClient } from '@supabase/supabase-js';
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
function validateConfiguration() {
 if (!url || !key) return 'Supabase is not configured. Create .env.local with VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY, then restart Vite. See docs/SUPABASE_SETUP.md.';
 try { const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error(); } catch { return 'Invalid Supabase Project URL.'; }
 if (!key.startsWith('sb_publishable_')) return 'Use a Supabase publishable key (sb_publishable_…), never a secret or service_role key.';
 return null;
}
export const configurationError = validateConfiguration();
export const supabase = configurationError ? null : createClient(url, key, { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
