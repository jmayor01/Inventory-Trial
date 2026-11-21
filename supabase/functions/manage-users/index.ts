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
// New accounts get an email with their sign-in details. A password left blank
// is made up here. Email goes out through Resend (secrets RESEND_API_KEY and
// EMAIL_FROM) or Gmail (secrets GMAIL_USER and GMAIL_APP_PASSWORD, sent over
// port 465, which Supabase allows). With neither set, or if sending fails, the
// password is returned once so the super admin can pass it on.
//
// Deploy with JWT verification off; the function does its own check below.

import { createClient } from 'npm:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6.9.16';

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

/** A 12-character password with letters and digits, leaving out look-alikes. */
function makePassword(): string {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = letters + digits;
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const pw = Array.from(bytes, (b) => all[b % all.length]).join('');
    if (/[0-9]/.test(pw) && /[a-zA-Z]/.test(pw)) return pw;
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

type Mail = { to: string; subject: string; text: string; html: string; fromName: string };

/** Sends an email through whichever service is set up. Never throws. */
async function sendMail(mail: Mail): Promise<{ ok: boolean; reason?: string }> {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  const resendFrom = Deno.env.get('EMAIL_FROM');
  const gmailUser = Deno.env.get('GMAIL_USER');
  const gmailPass = Deno.env.get('GMAIL_APP_PASSWORD');
  try {
    if (resendKey && resendFrom) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: resendFrom, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
      });
      if (res.ok) return { ok: true };
      const detail = await res.json().catch(() => ({}));
      return { ok: false, reason: `the email service refused it (${detail.message ?? res.status})` };
    }
    if (gmailUser && gmailPass) {
      const transport = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 465, secure: true,
        auth: { user: gmailUser, pass: gmailPass.replace(/\s+/g, '') },
      });
      await transport.sendMail({
        from: { name: mail.fromName, address: gmailUser },
        to: mail.to, subject: mail.subject, text: mail.text, html: mail.html,
      });
      return { ok: true };
    }
    return { ok: false, reason: 'email is not set up yet' };
  } catch (e) {
    return { ok: false, reason: `sending failed (${e instanceof Error ? e.message : String(e)})` };
  }
}

/** A button that shows in Outlook too: the colour sits on a table cell. */
function emailButton(href: string, label: string, primary: boolean): string {
  const bg = primary ? '#1f6feb' : '#ffffff';
  const fg = primary ? '#ffffff' : '#1f6feb';
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto">
<tr><td align="center" bgcolor="${bg}" style="background:${bg};border:2px solid #1f6feb;border-radius:8px;padding:12px 26px">
<a href="${escapeHtml(href)}" target="_blank" style="color:${fg};font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;text-decoration:none;display:inline-block">${escapeHtml(label)}</a>
</td></tr></table>`;
}

/** The sign-in email for a new account, or for a password set by a super admin. */
function credentialsMail(kind: 'new' | 'reset', to: string, password: string, storeName: string, role: string, link: string, storeLink: string): Mail {
  const roleName = role === 'super_admin' ? 'Super admin' : 'Admin';
  const isNew = kind === 'new';
  const heading = isNew ? `Welcome to ${storeName}` : 'Your password was changed';
  const intro = isNew
    ? `An account has been created for you at <strong>${escapeHtml(storeName)}</strong> as <strong>${roleName}</strong>. Here is everything you need to get started.`
    : `A super admin of <strong>${escapeHtml(storeName)}</strong> has set a new password for your account. Your old password no longer works.`;
  const preheader = isNew ? `Your sign-in details for ${storeName}` : `Your new password for ${storeName}`;
  const signInAt = link || storeLink;
  const shownEmail = escapeHtml(to);

  const steps = [
    storeLink ? `Tap <strong>Open ${escapeHtml(storeName)}</strong> above to open the store on your phone.` : '',
    `Sign in with the email and password above${link ? ' (Menu &rsaquo; Staff sign in, or the back office link)' : ''}.`,
    'Change your password under <strong>Profile &rsaquo; Change my password</strong>.',
    storeLink && isNew ? 'Optional: add the store to your home screen so it opens like an app.' : '',
  ].filter(Boolean);
  const stepRows = steps.map((s, i) => `<tr>
<td valign="top" style="padding:0 12px 12px 0;width:28px"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" bgcolor="#e8f0fe" style="background:#e8f0fe;border-radius:14px;width:28px;height:28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#1f6feb">${i + 1}</td></tr></table></td>
<td valign="top" style="padding:4px 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#2b3440">${s}</td>
</tr>`).join('');

  const linkLine = (label: string, href: string) => `<p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#5a6472">${label}: <a href="${escapeHtml(href)}" style="color:#1f6feb;word-break:break-all">${escapeHtml(href)}</a></p>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#eef1f5">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#eef1f5">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#eef1f5" style="background:#eef1f5">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px">

<tr><td bgcolor="#1f6feb" style="background:#1f6feb;border-radius:12px 12px 0 0;padding:26px 28px">
<p style="margin:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#d6e4ff">${escapeHtml(storeName)} &middot; Inventory</p>
<h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:1.3;color:#ffffff">${escapeHtml(heading)}</h1>
</td></tr>

<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:28px">
<p style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#2b3440">Hello,</p>
<p style="margin:0 0 22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#2b3440">${intro}</p>

<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f5f7fa" style="background:#f5f7fa;border:1px solid #dfe4ea;border-radius:10px">
<tr><td style="padding:18px 20px 6px;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#5a6472">Your sign-in details</td></tr>
<tr><td style="padding:6px 20px"><span style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5a6472">Email</span><br>
<span style="font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#141a21">${shownEmail}</span></td></tr>
<tr><td style="padding:10px 20px 18px"><span style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5a6472">${isNew ? 'Temporary password' : 'New password'}</span><br>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:6px"><tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px dashed #9aa5b1;border-radius:6px;padding:8px 14px;font-family:Consolas,Menlo,'Courier New',monospace;font-size:20px;font-weight:bold;letter-spacing:2px;color:#141a21">${escapeHtml(password)}</td></tr></table>
<span style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#5a6472">Capital and small letters matter.</span></td></tr>
</table>

${storeLink ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" style="padding:26px 0 10px">${emailButton(storeLink, `Open ${storeName}`, true)}</td></tr>` : '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">'}
${link ? `<tr><td align="center" style="padding:${storeLink ? '4' : '26'}px 0 6px">${emailButton(link, 'Back office sign in', !storeLink)}</td></tr>` : ''}
</table>

<h2 style="margin:24px 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:17px;color:#141a21">${isNew ? 'Getting started' : 'What to do now'}</h2>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${stepRows}</table>

<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px"><tr><td style="border-top:1px solid #e3e7ec;padding-top:16px">
<p style="margin:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5a6472">If a button doesn't work, copy these links into your browser:</p>
${storeLink ? linkLine('Store', storeLink) : ''}${link ? linkLine('Back office', link) : ''}${!signInAt ? '<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5a6472">Ask the store for the sign-in link.</p>' : ''}
</td></tr></table>
</td></tr>

<tr><td bgcolor="#f5f7fa" style="background:#f5f7fa;border-radius:0 0 12px 12px;border-top:1px solid #e3e7ec;padding:18px 28px">
<p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#5a6472"><strong>Keep this password private.</strong> The store will never ask you for it. Change it after your first sign-in, then delete this email.</p>
<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#5a6472">Not expecting this? You can ignore this email or let ${escapeHtml(storeName)} know.</p>
</td></tr>

</table>
</td></tr></table>
</body></html>`;

  const text = [
    heading, '',
    'Hello,', '',
    isNew
      ? `An account has been created for you at ${storeName} as ${roleName}.`
      : `A super admin of ${storeName} has set a new password for your account. Your old password no longer works.`,
    '',
    'YOUR SIGN-IN DETAILS',
    `Email: ${to}`,
    `${isNew ? 'Temporary password' : 'New password'}: ${password}`,
    '(Capital and small letters matter.)', '',
    ...(storeLink ? [`Open ${storeName}: ${storeLink}`] : []),
    ...(link ? [`Back office sign in: ${link}`] : []),
    '',
    isNew ? 'GETTING STARTED' : 'WHAT TO DO NOW',
    ...steps.map((s, i) => `${i + 1}. ${s.replace(/<[^>]+>/g, '').replace(/&rsaquo;/g, '>')}`),
    '',
    'Keep this password private. The store will never ask you for it. Change it after your first sign-in, then delete this email.',
    `Not expecting this? You can ignore this email or let ${storeName} know.`,
  ].join('\n');

  return {
    to, text, html, fromName: `${storeName} Inventory`,
    subject: isNew ? `Welcome to ${storeName}: your sign-in details` : `Your new password for ${storeName}`,
  };
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

  const { data: storeRow } = await admin.from('stores').select('name').eq('id', storeId).maybeSingle();
  const storeName = storeRow?.name ?? 'the store';
  // Where to sign in, as given by the back office; only plain web addresses.
  const appUrl = String(body.app_url ?? '');
  const okUrl = (u: string) => (/^https?:\/\/[^\s"'<>]{1,300}$/.test(u) ? u : '');
  const link = okUrl(appUrl);
  const storeLink = okUrl(String(body.store_url ?? ''));

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
    // "who" is an email address, or the 8-character account ID someone shared.
    const who = String(body.who ?? body.email ?? '').trim();
    const password = String(body.password ?? '');
    const role = String(body.role ?? '');
    if (role !== 'admin' && role !== 'super_admin') return json(400, { error: 'Choose a role.' });

    if (!who.includes('@')) {
      const code = who.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!/^[A-Z0-9]{8}$/.test(code)) return json(400, { error: 'Enter an email address or an 8-character account ID.' });
      const { data: found } = await admin.from('profiles').select('user_id, email').eq('account_code', code).maybeSingle();
      if (!found) return json(404, { error: 'No account has that ID. Check it with the person.' });
      const { data: already } = await admin.from('store_members').select('role').eq('store_id', storeId).eq('user_id', found.user_id).maybeSingle();
      if (already) return json(409, { error: 'That person is already in this store.' });
      const { error } = await admin.from('store_members').insert({ store_id: storeId, user_id: found.user_id, role });
      if (error) return json(500, { error: 'Could not add them to the store.' });
      return json(200, { user: { user_id: found.user_id, email: found.email, role }, existing: true });
    }

    const email = who.toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return json(400, { error: 'Enter a valid email address.' });

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

    // A password left blank is made up here and sent to them.
    const generated = password === '';
    const newPassword = generated ? makePassword() : password;
    if (newPassword.length < 8) return json(400, { error: 'A password needs at least 8 characters. Leave it empty to have one made up.' });
    const { data: created, error } = await admin.auth.admin.createUser({ email, password: newPassword, email_confirm: true });
    if (error || !created?.user) {
      const taken = /already|registered|exists/i.test(error?.message ?? '');
      return json(taken ? 409 : 400, {
        error: taken ? 'An account with that email exists but is not set up for the back office. Ask for help to link it.' : (error?.message ?? 'Could not create the account.'),
      });
    }
    const userId = created.user.id;
    // profiles.role is from before stores existed and grants nothing; it is
    // filled in only because older databases still require a value there.
    const { error: profileError } = await admin.from('profiles').insert({ user_id: userId, email, role });
    const { error: memberError } = profileError
      ? { error: profileError }
      : await admin.from('store_members').insert({ store_id: storeId, user_id: userId, role });
    if (memberError) {
      await admin.auth.admin.deleteUser(userId); // do not leave an account that cannot get in
      return json(500, { error: 'Could not set up the account, so it was not created.' });
    }
    const mail = await sendMail(credentialsMail('new', email, newPassword, storeName, role, link, storeLink));
    return json(200, {
      user: { user_id: userId, email, role }, existing: false,
      emailed: mail.ok, email_problem: mail.reason ?? null,
      // Shown once to the super admin when they need to pass it on themselves.
      password: generated || !mail.ok ? newPassword : null,
    });
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
    const generated = String(body.password ?? '') === '';
    const password = generated ? makePassword() : String(body.password);
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
    const { data: theirs } = await admin.from('store_members').select('role').eq('store_id', storeId).eq('user_id', userId).maybeSingle();
    const mail = target
      ? await sendMail(credentialsMail('reset', String(target.email), password, storeName, theirs?.role ?? 'admin', link, storeLink))
      : { ok: false, reason: 'they have no email address on file' };
    return json(200, { ok: true, emailed: mail.ok, email_problem: mail.reason ?? null, password: generated || !mail.ok ? password : null });
  }

  return json(400, { error: 'Unknown action.' });
});
