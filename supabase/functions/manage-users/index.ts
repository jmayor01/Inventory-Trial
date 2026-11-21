// Adds people to a store, removes them, and resets passwords. Only a super
// admin of that store may call it.
//
// The browser cannot create Supabase Auth users itself (that needs a secret
// key), so the back office calls this function instead. It checks who is
// calling, then uses the project's secret key, which never leaves the server.
//
// One account can belong to several stores. A super admin of one store can
// add an existing account to their store, but can never change anything that
// would reach into another store: an account that also belongs to a store the
// caller does not run keeps its password, and removing it only takes it out of
// the caller's store.
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
  const callerId = caller.user.id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'The request was not valid JSON.' });
  }

  // Every action happens in one store, which the caller must run.
  const storeId = String(body.store_id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(storeId)) return json(400, { error: 'No store was given.' });
  const { data: mine } = await admin.from('store_members').select('role').eq('store_id', storeId).eq('user_id', callerId).maybeSingle();
  if (mine?.role !== 'super_admin') return json(403, { error: 'Only a super admin of this store can manage its users.' });

  /** The stores an account belongs to. */
  const storesOf = async (userId: string): Promise<string[]> => {
    const { data } = await admin.from('store_members').select('store_id').eq('user_id', userId);
    return (data ?? []).map((r) => r.store_id as string);
  };
  /** True when the caller is a super admin of every one of these stores. */
  const runsAll = async (storeIds: string[]): Promise<boolean> => {
    if (!storeIds.length) return true;
    const { data } = await admin.from('store_members').select('store_id').eq('user_id', callerId).eq('role', 'super_admin').in('store_id', storeIds);
    return (data ?? []).length === new Set(storeIds).size;
  };

  if (body.action === 'add') {
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const role = String(body.role ?? '');
    if (!/^\S+@\S+\.\S+$/.test(email)) return json(400, { error: 'Enter a valid email address.' });
    if (role !== 'admin' && role !== 'super_admin') return json(400, { error: 'Choose a role.' });

    // Someone who already has an account (for instance at another store) is
    // just added to this store, with their own password unchanged.
    const { data: existing } = await admin.from('profiles').select('user_id').eq('email', email).maybeSingle();
    if (existing) {
      const { data: already } = await admin.from('store_members').select('role').eq('store_id', storeId).eq('user_id', existing.user_id).maybeSingle();
      if (already) return json(409, { error: 'That person is already in this store.' });
      const { error } = await admin.from('store_members').insert({ store_id: storeId, user_id: existing.user_id, role });
      if (error) return json(500, { error: 'Could not add them to the store.' });
      return json(200, { user: { user_id: existing.user_id, email, role }, existing: true });
    }

    if (password.length < 8) return json(400, { error: 'A new account needs a password of at least 8 characters.' });
    const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !created?.user) {
      const taken = /already|registered|exists/i.test(error?.message ?? '');
      return json(taken ? 409 : 400, {
        error: taken ? 'An account with that email exists but is not set up for the back office. Ask for help to link it.' : (error?.message ?? 'Could not create the account.'),
      });
    }
    const userId = created.user.id;
    const { error: profileError } = await admin.from('profiles').insert({ user_id: userId, email });
    const { error: memberError } = profileError
      ? { error: profileError }
      : await admin.from('store_members').insert({ store_id: storeId, user_id: userId, role });
    if (memberError) {
      await admin.auth.admin.deleteUser(userId); // do not leave an account that cannot get in
      return json(500, { error: 'Could not set up the account, so it was not created.' });
    }
    return json(200, { user: { user_id: userId, email, role }, existing: false });
  }

  if (body.action === 'remove') {
    const userId = String(body.user_id ?? '');
    if (!userId) return json(400, { error: 'No user was given.' });
    if (userId === callerId) return json(400, { error: 'You cannot remove yourself.' });
    const { error } = await admin.from('store_members').delete().eq('store_id', storeId).eq('user_id', userId);
    if (error) return json(400, { error: error.message });
    // An account left in no store at all can no longer be used, so it goes.
    const left = await storesOf(userId);
    if (!left.length) await admin.auth.admin.deleteUser(userId); // the profile goes with it
    return json(200, { ok: true, deleted: !left.length });
  }

  if (body.action === 'set_password') {
    const userId = String(body.user_id ?? '');
    const password = String(body.password ?? '');
    if (!userId) return json(400, { error: 'No user was given.' });
    if (password.length < 8) return json(400, { error: 'The password needs at least 8 characters.' });
    const stores = await storesOf(userId);
    if (!stores.includes(storeId)) return json(404, { error: 'That person is not in this store.' });
    // A password opens every store the account belongs to, so only someone
    // who runs all of those stores may set it.
    if (!(await runsAll(stores))) {
      return json(403, { error: 'This person also works at a store you do not run, so you cannot change their password. A super admin who runs all their stores can.' });
    }
    const { error } = await admin.auth.admin.updateUserById(userId, { password });
    if (error) return json(400, { error: error.message });
    const { data: target } = await admin.from('profiles').select('email').eq('user_id', userId).maybeSingle();
    // Wrong-password counts from before the reset no longer apply.
    if (target) await admin.from('attempt_counters').update({ failed: 0 }).eq('kind', 'login').eq('who', String(target.email).toLowerCase());
    return json(200, { ok: true });
  }

  return json(400, { error: 'Unknown action.' });
});
