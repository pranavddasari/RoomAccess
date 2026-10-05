import { createClient } from '@supabase/supabase-js';
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const configurationError = !url || !key
  ? 'Supabase is not configured. Create .env.local with VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY, then restart Vite. See docs/SUPABASE_SETUP.md.'
  : !/^https?:\/\//.test(url) || !(key.startsWith('sb_publishable_') || key.split('.').length === 3)
    ? 'Invalid Supabase configuration. Use the Project URL and publishable key.' : null;
export const supabase = configurationError ? null : createClient(url, key, { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
