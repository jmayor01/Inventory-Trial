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
// It also sends the "Forgot password?" reset links (no sign-in needed, rate
// limited, links only ever point at APP_ORIGINS) and the alerts the database
// queues in notify_outbox when a sale is edited or cancelled.
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

// Where links in emails may point. Reset links in particular must never go
// anywhere else, or someone could ask for one that lands on their own site.
const ORIGINS = (Deno.env.get('APP_ORIGINS') ?? 'https://inventory-trial.vercel.app')
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const siteOrigin = (asked: unknown) => (ORIGINS.includes(String(asked ?? '')) ? String(asked) : ORIGINS[0]);

const TIME_ZONE = Deno.env.get('APP_TIME_ZONE') ?? 'Asia/Manila';
const peso = (n: number) => '₱' + new Intl.NumberFormat('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-PH', { timeZone: TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' }) : '');

const FONT = 'font-family:Arial,Helvetica,sans-serif';
const p = (html: string, style = '') => `<p style="margin:0 0 16px;${FONT};font-size:15px;line-height:1.6;color:#2b3440;${style}">${html}</p>`;
const small = (html: string) => `<p style="margin:0 0 6px;${FONT};font-size:12px;line-height:1.5;color:#5a6472">${html}</p>`;

/** A button that shows in Outlook too: the colour sits on a table cell. */
function emailButton(href: string, label: string, primary: boolean): string {
  const bg = primary ? '#1f6feb' : '#ffffff';
  const fg = primary ? '#ffffff' : '#1f6feb';
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto">
<tr><td align="center" bgcolor="${bg}" style="background:${bg};border:2px solid #1f6feb;border-radius:8px;padding:12px 26px">
<a href="${escapeHtml(href)}" target="_blank" style="color:${fg};${FONT};font-size:16px;font-weight:bold;text-decoration:none;display:inline-block">${escapeHtml(label)}</a>
</td></tr></table>`;
}

/** Centred buttons, one under the other. */
function buttons(list: Array<[string, string]>): string {
  const rows = list.filter(([href]) => href).map(([href, label], i) =>
    `<tr><td align="center" style="padding:${i ? 4 : 22}px 0 8px">${emailButton(href, label, i === 0)}</td></tr>`).join('');
  return rows ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table>` : '';
}

/** A grey card of label / value rows. */
function card(title: string, rows: string): string {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f5f7fa" style="background:#f5f7fa;border:1px solid #dfe4ea;border-radius:10px">
<tr><td style="padding:18px 20px 6px;${FONT};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#5a6472">${escapeHtml(title)}</td></tr>
${rows}
<tr><td style="padding:0 0 12px"></td></tr></table>`;
}
const cardRow = (label: string, valueHtml: string) => `<tr><td style="padding:6px 20px"><span style="${FONT};font-size:13px;color:#5a6472">${escapeHtml(label)}</span><br>
<span style="${FONT};font-size:16px;font-weight:bold;color:#141a21">${valueHtml}</span></td></tr>`;

/** Numbered steps. */
function steps(title: string, list: string[]): string {
  const rows = list.map((s, i) => `<tr>
<td valign="top" style="padding:0 12px 12px 0;width:28px"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" bgcolor="#e8f0fe" style="background:#e8f0fe;border-radius:14px;width:28px;height:28px;${FONT};font-size:14px;font-weight:bold;color:#1f6feb">${i + 1}</td></tr></table></td>
<td valign="top" style="padding:4px 0 12px;${FONT};font-size:15px;line-height:1.5;color:#2b3440">${s}</td>
</tr>`).join('');
  return `<h2 style="margin:24px 0 14px;${FONT};font-size:17px;color:#141a21">${escapeHtml(title)}</h2>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table>`;
}

/** Links written out, for when a button does not work. */
function fallbackLinks(list: Array<[string, string]>): string {
  const lines = list.filter(([href]) => href).map(([href, label]) =>
    `<p style="margin:0 0 6px;${FONT};font-size:13px;line-height:1.5;color:#5a6472">${escapeHtml(label)}: <a href="${escapeHtml(href)}" style="color:#1f6feb;word-break:break-all">${escapeHtml(href)}</a></p>`).join('');
  return lines ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px"><tr><td style="border-top:1px solid #e3e7ec;padding-top:16px">
<p style="margin:0 0 8px;${FONT};font-size:13px;color:#5a6472">If a button doesn't work, copy ${list.filter(([h]) => h).length > 1 ? 'these links' : 'this link'} into your browser:</p>${lines}</td></tr></table>` : '';
}

/** The page every email shares: coloured header, white body, grey footer. */
function shell(o: { kicker: string; heading: string; preheader: string; body: string; footer: string; accent?: string }): string {
  const accent = o.accent ?? '#1f6feb';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${escapeHtml(o.heading)}</title></head>
<body style="margin:0;padding:0;background:#eef1f5">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#eef1f5">${escapeHtml(o.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#eef1f5" style="background:#eef1f5">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px">
<tr><td bgcolor="${accent}" style="background:${accent};border-radius:12px 12px 0 0;padding:26px 28px">
<p style="margin:0 0 4px;${FONT};font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#e3ecff">${escapeHtml(o.kicker)}</p>
<h1 style="margin:0;${FONT};font-size:24px;line-height:1.3;color:#ffffff">${escapeHtml(o.heading)}</h1>
</td></tr>
<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:28px">${o.body}</td></tr>
<tr><td bgcolor="#f5f7fa" style="background:#f5f7fa;border-radius:0 0 12px 12px;border-top:1px solid #e3e7ec;padding:18px 28px">${o.footer}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/** Plain-text version of a few HTML bits. */
const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&rsaquo;/g, '>').replace(/&middot;/g, '·').replace(/&amp;/g, '&');

/** The sign-in email for a new account, or for a password set by a super admin. */
function credentialsMail(kind: 'new' | 'reset', to: string, password: string, storeName: string, role: string, link: string, storeLink: string): Mail {
  const roleName = role === 'super_admin' ? 'Super admin' : 'Admin';
  const isNew = kind === 'new';
  const heading = isNew ? `Welcome to ${storeName}` : 'Your password was changed';
  const intro = isNew
    ? `An account has been created for you at <strong>${escapeHtml(storeName)}</strong> as <strong>${roleName}</strong>. Here is everything you need to get started.`
    : `A super admin of <strong>${escapeHtml(storeName)}</strong> has set a new password for your account. Your old password no longer works.`;
  const todo = [
    storeLink ? `Tap <strong>Open ${escapeHtml(storeName)}</strong> above to open the store on your phone.` : '',
    `Sign in with the email and temporary password above${link ? ' (Menu &rsaquo; Staff sign in, or the back office link)' : ''}.`,
    'You will be asked to choose your own password straight away.',
    storeLink && isNew ? 'Optional: add the store to your home screen so it opens like an app.' : '',
  ].filter(Boolean);

  const passwordBox = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:6px"><tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px dashed #9aa5b1;border-radius:6px;padding:8px 14px;font-family:Consolas,Menlo,'Courier New',monospace;font-size:20px;font-weight:bold;letter-spacing:2px;color:#141a21">${escapeHtml(password)}</td></tr></table>
<span style="${FONT};font-size:12px;font-weight:normal;color:#5a6472">Capital and small letters matter.</span>`;
  const html = shell({
    kicker: `${storeName} · Inventory`, heading,
    preheader: isNew ? `Your sign-in details for ${storeName}` : `Your new password for ${storeName}`,
    body: p('Hello,') + p(intro, 'margin-bottom:22px') +
      card('Your sign-in details', cardRow('Email', escapeHtml(to)) + cardRow('Temporary password', passwordBox)) +
      buttons([[storeLink, `Open ${storeName}`], [link, 'Back office sign in']]) +
      steps(isNew ? 'Getting started' : 'What to do now', todo) +
      fallbackLinks([[storeLink, 'Store'], [link, 'Back office']]),
    footer: small('<strong>Keep this password private.</strong> The store will never ask you for it. After you choose your own password, delete this email.') +
      small(`Not expecting this? You can ignore this email or let ${escapeHtml(storeName)} know.`),
  });
  const text = [
    heading, '', 'Hello,', '', plain(intro), '',
    'YOUR SIGN-IN DETAILS', `Email: ${to}`, `Temporary password: ${password}`, '(Capital and small letters matter.)', '',
    ...(storeLink ? [`Open ${storeName}: ${storeLink}`] : []),
    ...(link ? [`Back office sign in: ${link}`] : []), '',
    isNew ? 'GETTING STARTED' : 'WHAT TO DO NOW',
    ...todo.map((s, i) => `${i + 1}. ${plain(s).replace(' above', '')}`), '',
    'Keep this password private. The store will never ask you for it. After you choose your own password, delete this email.',
    `Not expecting this? You can ignore this email or let ${storeName} know.`,
  ].join('\n');
  return { to, text, html, fromName: `${storeName} Inventory`, subject: isNew ? `Welcome to ${storeName}: your sign-in details` : `Your new password for ${storeName}` };
}

/** The "Forgot password?" email with a one-time link. */
function resetLinkMail(to: string, link: string): Mail {
  const html = shell({
    kicker: 'Inventory · Back office', heading: 'Reset your password',
    preheader: 'Use this link within 1 hour to choose a new password.',
    body: p('Hello,') +
      p(`Someone (hopefully you) asked to reset the password for <strong>${escapeHtml(to)}</strong>. Tap the button below to choose a new one.`) +
      buttons([[link, 'Choose a new password']]) +
      p('The link works <strong>once</strong> and expires in <strong>1 hour</strong>. If it has expired, ask for a new one on the sign-in screen.', 'margin-top:12px;font-size:14px;color:#5a6472') +
      fallbackLinks([[link, 'Reset link']]),
    footer: small("<strong>Didn't ask for this?</strong> You can ignore this email; your password stays the same. If you keep getting these, let your store's super admin know."),
  });
  const text = [
    'Reset your password', '', 'Hello,', '',
    `Someone (hopefully you) asked to reset the password for ${to}. Open this link to choose a new one:`, link, '',
    'The link works once and expires in 1 hour. If it has expired, ask for a new one on the sign-in screen.', '',
    "Didn't ask for this? You can ignore this email; your password stays the same.",
  ].join('\n');
  return { to, text, html, fromName: 'Inventory', subject: 'Reset your Inventory password' };
}

type SaleAlert = {
  kind: 'sale_voided' | 'sale_edited'; storeName: string; saleId: string; soldBy: string; soldAt: string;
  by: string; at: string; before: number; after: number; lines: Array<{ name: string; qty: number; price: number }>; link: string;
};

/** Tells a store's super admins that a sale was cancelled or changed. */
function saleAlertMail(to: string, a: SaleAlert): Mail {
  const voided = a.kind === 'sale_voided';
  const ref = a.saleId.slice(0, 8).toUpperCase();
  const heading = voided ? 'A sale was cancelled' : 'A sale was edited';
  const diff = a.after - a.before;
  const change = voided
    ? `${peso(a.before)} &rarr; <span style="color:#c62828">cancelled</span>`
    : `${peso(a.before)} &rarr; ${peso(a.after)} <span style="color:${diff < 0 ? '#c62828' : '#2e7d32'}">(${diff < 0 ? '−' : '+'}${peso(Math.abs(diff))})</span>`;
  const lineRows = a.lines.map((l) => `<tr>
<td style="padding:8px 0;border-bottom:1px solid #eef1f5;${FONT};font-size:14px;color:#2b3440">${escapeHtml(l.name)}</td>
<td align="right" style="padding:8px 0 8px 10px;border-bottom:1px solid #eef1f5;${FONT};font-size:14px;color:#5a6472;white-space:nowrap">${l.qty} × ${peso(l.price)}</td>
<td align="right" style="padding:8px 0 8px 10px;border-bottom:1px solid #eef1f5;${FONT};font-size:14px;font-weight:bold;color:#141a21;white-space:nowrap">${peso(l.qty * l.price)}</td></tr>`).join('');
  const lineTitle = voided ? 'Items put back in stock' : 'Items in the sale now';
  const html = shell({
    kicker: `${a.storeName} · Sales alert`, heading, accent: voided ? '#c62828' : '#b26a00',
    preheader: `${voided ? 'Cancelled' : 'Edited'} by ${a.by || 'staff'}: sale ${ref}, ${voided ? peso(a.before) : `${peso(a.before)} → ${peso(a.after)}`}`,
    body: p(`<strong>${escapeHtml(a.by || 'A staff member')}</strong> ${voided ? 'cancelled' : 'changed'} a sale at <strong>${escapeHtml(a.storeName)}</strong>. ${voided ? 'Its items were put back in stock.' : 'Stock was adjusted to match.'}`) +
      card('Sale ' + ref,
        cardRow('Total', change) +
        cardRow('Sold', `${escapeHtml(when(a.soldAt))} &middot; ${escapeHtml(a.soldBy || 'Cashier')}`) +
        cardRow(voided ? 'Cancelled' : 'Edited', `${escapeHtml(when(a.at))} &middot; ${escapeHtml(a.by || 'unknown')}`)) +
      (lineRows ? `<h2 style="margin:24px 0 6px;${FONT};font-size:17px;color:#141a21">${lineTitle}</h2>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${lineRows}</table>` : '') +
      buttons([[a.link, 'Review sales']]) +
      p("If you don't recognise this change, check with the person who made it.", 'margin-top:12px;font-size:14px;color:#5a6472'),
    footer: small(`You get this email because you are a super admin of ${escapeHtml(a.storeName)}. Changing or cancelling a sale always needs the staff member's password.`),
  });
  const text = [
    `${heading} at ${a.storeName}`, '',
    `${a.by || 'A staff member'} ${voided ? 'cancelled' : 'changed'} sale ${ref}.`,
    `Total: ${peso(a.before)} -> ${voided ? 'cancelled' : peso(a.after)}`,
    `Sold: ${when(a.soldAt)} by ${a.soldBy || 'Cashier'}`,
    `${voided ? 'Cancelled' : 'Edited'}: ${when(a.at)} by ${a.by || 'unknown'}`, '',
    lineTitle.toUpperCase(), ...a.lines.map((l) => `- ${l.name}: ${l.qty} x ${peso(l.price)} = ${peso(l.qty * l.price)}`), '',
    a.link ? `Review sales: ${a.link}` : '',
  ].join('\n');
  return { to, text, html, fromName: `${a.storeName} Inventory`, subject: `${voided ? 'Sale cancelled' : 'Sale edited'} at ${a.storeName}: ${ref} (${voided ? peso(a.before) : `${peso(a.before)} → ${peso(a.after)}`})` };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });

  const key = secretKey();
  if (!key) return json(500, { error: 'The function has no secret key to work with.' });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'The request was not valid JSON.' });
  }

  // These two need no sign-in.
  if (body.action === 'forgot') return forgotPassword(admin, req, body);
  if (body.action === 'outbox') return sendQueued(admin, String(body.id ?? ''));

  // Who is calling?
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Sign in first.' });
  const { data: caller, error: callerError } = await admin.auth.getUser(token);
  if (callerError || !caller?.user) return json(401, { error: 'Your session has expired. Sign in again.' });
  const callerId = caller.user.id;

  // After someone chooses their own password (first sign-in, or a reset link),
  // the "choose a password" step is done and old wrong tries no longer count.
  if (body.action === 'password_changed') {
    await admin.auth.admin.updateUserById(callerId, { app_metadata: { must_change_password: false } });
    if (caller.user.email) await admin.from('attempt_counters').update({ failed: 0 }).eq('kind', 'login').eq('who', caller.user.email.toLowerCase());
    return json(200, { ok: true });
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
    const { data: created, error } = await admin.auth.admin.createUser({ email, password: newPassword, email_confirm: true, app_metadata: { must_change_password: true } });
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

  if (body.action === 'set_password' || body.action === 'resend') {
    const userId = String(body.user_id ?? '');
    const generated = body.action === 'resend' || String(body.password ?? '') === '';
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
    // A welcome email can be sent again only while they have not yet chosen
    // their own password; after that it is a normal reset.
    const welcome = body.action === 'resend';
    if (welcome) {
      const { data: u } = await admin.auth.admin.getUserById(userId);
      if (!u?.user?.app_metadata?.must_change_password) return json(400, { error: 'They have already chosen their own password. Use Reset password instead.' });
    }
    // Either way they must choose their own password when they next sign in.
    const { error } = await admin.auth.admin.updateUserById(userId, { password, app_metadata: { must_change_password: true } });
    if (error) return json(400, { error: error.message });
    const { data: target } = await admin.from('profiles').select('email').eq('user_id', userId).maybeSingle();
    // Wrong-password counts from before the reset no longer apply.
    if (target) await admin.from('attempt_counters').update({ failed: 0 }).eq('kind', 'login').eq('who', String(target.email).toLowerCase());
    const { data: theirs } = await admin.from('store_members').select('role').eq('store_id', storeId).eq('user_id', userId).maybeSingle();
    const mail = target
      ? await sendMail(credentialsMail(welcome ? 'new' : 'reset', String(target.email), password, storeName, theirs?.role ?? 'admin', link, storeLink))
      : { ok: false, reason: 'they have no email address on file' };
    return json(200, { ok: true, emailed: mail.ok, email_problem: mail.reason ?? null, password: generated || !mail.ok ? password : null });
  }

  // Who has signed in and chosen their own password yet, for the Users list.
  if (body.action === 'statuses') {
    const { data: members } = await admin.from('store_members').select('user_id').eq('store_id', storeId);
    const statuses: Record<string, { signed_in: boolean; must_change: boolean }> = {};
    await Promise.all((members ?? []).map(async (r) => {
      const { data } = await admin.auth.admin.getUserById(r.user_id as string);
      if (data?.user) statuses[r.user_id as string] = { signed_in: Boolean(data.user.last_sign_in_at), must_change: Boolean(data.user.app_metadata?.must_change_password) };
    }));
    return json(200, { statuses });
  }

  return json(400, { error: 'Unknown action.' });
});

// ---------- No sign-in needed ----------

// deno-lint-ignore no-explicit-any
type Admin = ReturnType<typeof createClient<any>>;

/** Adds one to a 15-minute counter and returns the new count. */
async function bump(admin: Admin, who: string): Promise<number> {
  const { data: row } = await admin.from('attempt_counters').select('failed, window_start').eq('kind', 'login').eq('who', who).maybeSingle();
  const fresh = !row || new Date(row.window_start as string).getTime() < Date.now() - 15 * 60 * 1000;
  const failed = fresh ? 1 : Number(row!.failed) + 1;
  await admin.from('attempt_counters').upsert({ kind: 'login', who, failed, window_start: fresh ? new Date().toISOString() : row!.window_start });
  return failed;
}

/**
 * "Forgot password?": emails a one-time link (valid 1 hour) that lets the
 * person choose a new password. The answer is the same whether or not the
 * account exists, so it cannot be used to find out who has one. At most 3
 * emails per address and 10 requests per network address in 15 minutes.
 */
async function forgotPassword(admin: Admin, req: Request, body: Record<string, unknown>): Promise<Response> {
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 200) return json(400, { error: 'Enter a valid email address.' });
  const ip = req.headers.get('cf-connecting-ip') || (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  if ((await bump(admin, `forgot-ip:${ip}`)) > 10) return json(429, { error: 'Too many requests. Wait 15 minutes and try again.' });
  const done = json(200, { ok: true });
  if ((await bump(admin, `forgot:${email}`)) > 3) return done; // quietly: they already have recent links

  const { data: profile } = await admin.from('profiles').select('user_id').eq('email', email).maybeSingle();
  if (!profile) return done;
  const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email });
  const hashed = data?.properties?.hashed_token;
  if (error || !hashed) return done;
  const link = `${siteOrigin(body.origin)}/admin.html#reset=${encodeURIComponent(hashed)}`;
  await sendMail(resetLinkMail(email, link));
  return done;
}

/**
 * Sends one alert the database queued in notify_outbox (when a sale is
 * edited or cancelled). Each row is sent once: it is claimed by setting
 * sent_at, so calling again, or with an id that does not exist, does nothing.
 */
async function sendQueued(admin: Admin, id: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json(400, { error: 'No id.' });
  const { data: job } = await admin.from('notify_outbox').update({ sent_at: new Date().toISOString() }).eq('id', id).is('sent_at', null).select().maybeSingle();
  if (!job) return json(200, { ok: false });
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const saleId = String(payload.sale_id ?? '');
  const [{ data: storeRow }, { data: sale }, { data: lines }, { data: supers }] = await Promise.all([
    admin.from('stores').select('name, slug').eq('id', job.store_id).maybeSingle(),
    admin.from('sales').select('sold_by, created_at, total, voided_at, voided_by, edited_at, edited_by').eq('id', saleId).maybeSingle(),
    admin.from('sale_lines').select('name, qty, price').eq('sale_id', saleId).order('name'),
    admin.from('store_members').select('user_id').eq('store_id', job.store_id).eq('role', 'super_admin'),
  ]);
  if (!sale || !storeRow) {
    await admin.from('notify_outbox').update({ result: 'sale or store not found' }).eq('id', id);
    return json(200, { ok: false });
  }
  const ids = (supers ?? []).map((r) => r.user_id as string);
  const { data: people } = ids.length ? await admin.from('profiles').select('email').in('user_id', ids) : { data: [] };
  const voided = job.kind === 'sale_voided';
  const alert: SaleAlert = {
    kind: voided ? 'sale_voided' : 'sale_edited', storeName: storeRow.name as string, saleId,
    soldBy: sale.sold_by as string, soldAt: sale.created_at as string,
    by: String((voided ? sale.voided_by : sale.edited_by) ?? ''), at: String((voided ? sale.voided_at : sale.edited_at) ?? job.created_at),
    before: Number(payload.old_total ?? 0), after: Number(payload.new_total ?? sale.total ?? 0),
    lines: (lines ?? []).map((l) => ({ name: String(l.name), qty: Number(l.qty), price: Number(l.price) })),
    link: `${ORIGINS[0]}/admin.html?store=${encodeURIComponent(String(storeRow.slug))}`,
  };
  const results: string[] = [];
  for (const person of people ?? []) {
    const r = await sendMail(saleAlertMail(String(person.email), alert));
    results.push(`${person.email}: ${r.ok ? 'sent' : r.reason}`);
  }
  await admin.from('notify_outbox').update({ result: results.join('; ').slice(0, 1000) || 'no super admins' }).eq('id', id);
  return json(200, { ok: true });
}
