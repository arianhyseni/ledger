/* ---------------------------------------------------------
   config.js — Supabase connection

   The anon/publishable key is meant to be public. It is safe
   in the browser because Row Level Security in Postgres is
   what actually isolates each user's rows.

   Leave the key as-is and the app runs local-only, exactly
   as before, with no login and no sync.
--------------------------------------------------------- */

const SUPABASE_URL = 'https://hoikjekmkftcznnvttzh.supabase.co';
const SUPABASE_KEY = 'sb_publishable_7rAKoqf7CdguCsD1o4XHrA_NGdI4deB';

const CLOUD_ENABLED = !SUPABASE_KEY.startsWith('PASTE_');
