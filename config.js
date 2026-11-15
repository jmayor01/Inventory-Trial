// Supabase project the app stores the shared inventory in.
// The publishable key is meant to be public; access is protected by login
// and by the row level security rules in supabase/setup.sql.
// Never put a Supabase *secret* key in this file.
// If the project URL changes, change it in vercel.json too: the security
// policy there only lets the pages talk to this one Supabase project.
window.INVENTORY_CONFIG = {
  supabaseUrl: 'https://ydfihqnfugzbcydvksvl.supabase.co',
  supabaseKey: 'sb_publishable_UUCZLadvAr-YLoP1_EEi2g_80mIdk7l',
};
