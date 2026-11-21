import { createClient } from '@supabase/supabase-js';

// Public values (safe to ship in the app). Access is controlled by the database rules.
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://nskbksmguplcdchbbxje.supabase.co';
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_stVo5g5OaNn4MvqP9t5aww_SHzrvw0t';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export const BUCKET = 'listing-media';
export const mediaUrl = (path) => (path ? `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}` : '');

// Phone-based accounts: Supabase Auth needs an email, so each phone maps to a private address that is never emailed.
export const phoneEmail = (phone) => `p${phone}@phone.shambasoko.app`;
