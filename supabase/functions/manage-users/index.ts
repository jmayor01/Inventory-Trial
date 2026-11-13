// Creates and removes back-office accounts. Only a super admin may call it.
//
// The browser cannot create Supabase Auth users itself (that needs a secret
// key), so the back office calls this function instead. It checks who is
// calling, then uses the project's secret key, which never leaves the server.
//
// Deploy with JWT verification off; the function does its own check below.

import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

function secretKey(): string {
  const named = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (named) {
    try {
      const key = JSON.parse(named)['default'];
      if (key) return key;
    } catch { /* fall through to the legacy key */ }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });

  const key = secretKey();
  if (!key) return json(500, { error: 'The function has no secret key to work with.' });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Who is calling?
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Sign in first.' });
  const { data: caller, error: callerError } = await admin.auth.getUser(token);
  if (callerError || !caller?.user) return json(401, { error: 'Your session has expired. Sign in again.' });
  const { data: me } = await admin.from('profiles').select('role').eq('user_id', caller.user.id).maybeSingle();
  if (me?.role !== 'super_admin') return json(403, { error: 'Only a super admin can manage users.' });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'The request was not valid JSON.' });
  }

  if (body.action === 'create') {
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const role = String(body.role ?? '');
    if (!/^\S+@\S+\.\S+$/.test(email)) return json(400, { error: 'Enter a valid email address.' });
    if (password.length < 8) return json(400, { error: 'The password needs at least 8 characters.' });
    if (role !== 'admin' && role !== 'super_admin') return json(400, { error: 'Choose a role.' });

    const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !created?.user) {
      const taken = /already|registered|exists/i.test(error?.message ?? '');
      return json(taken ? 409 : 400, { error: taken ? 'An account with that email already exists.' : (error?.message ?? 'Could not create the account.') });
    }
    const { error: profileError } = await admin.from('profiles').insert({ user_id: created.user.id, email, role });
    if (profileError) {
      await admin.auth.admin.deleteUser(created.user.id); // do not leave an account without a role behind
      return json(500, { error: 'Could not save the role, so the account was not created.' });
    }
    return json(200, { user: { user_id: created.user.id, email, role } });
  }

  if (body.action === 'delete') {
    const userId = String(body.user_id ?? '');
    if (!userId) return json(400, { error: 'No user was given.' });
    if (userId === caller.user.id) return json(400, { error: 'You cannot remove your own account.' });
    const { error } = await admin.auth.admin.deleteUser(userId); // the profile row goes with it
    if (error) return json(400, { error: error.message });
    return json(200, { ok: true });
  }

  return json(400, { error: 'Unknown action.' });
});
