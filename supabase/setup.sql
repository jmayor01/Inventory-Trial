-- Inventory: database setup for Supabase.
-- Paste this whole file into Supabase > SQL Editor and press Run.
-- It is safe to run more than once.
--
-- Stores: every product, sale and passcode belongs to one store, and nothing
-- from one store is visible from another. An account can belong to several
-- stores, with a role in each.
--
-- Who can do what in a store (enforced here, not just in the app):
--   Nobody signed in  -> look up one item by its exact barcode (via the store's link)
--   With a passcode   -> also view that store's whole list of items
--   Cashier passcode  -> also sell: take items out of stock through a recorded sale
--   Admin             -> add, change and delete items, change stock, import,
--                        original prices and profit, sales, passcodes
--   Super admin       -> everything an admin can, plus the store's user accounts
--                        and creating more stores

-- Items -----------------------------------------------------------------------

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  barcode text not null default '',
  name text not null check (length(trim(name)) > 0),
  description text not null default '',
  price numeric(12, 2) not null default 0 check (price >= 0),
  qty integer not null default 0 check (qty >= 0),
  photo_updated_at timestamptz,
  updated_at timestamptz not null default now()
);

create or replace function public.items_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists items_touch_updated_at on public.items;
create trigger items_touch_updated_at
  before update on public.items
  for each row execute function public.items_touch_updated_at();

-- Photos live in their own table so that loading the list stays fast.
create table if not exists public.item_photos (
  item_id uuid primary key references public.items (id) on delete cascade,
  data text not null check (data like 'data:image/%' and length(data) < 1500000)
);

-- Original (cost) prices, kept apart from items so that only signed-in staff
-- can read them. Profit is worked out from these.
create table if not exists public.item_costs (
  item_id uuid primary key references public.items (id) on delete cascade,
  cost numeric(12, 2) not null check (cost >= 0),
  updated_at timestamptz not null default now()
);

-- Roles -------------------------------------------------------------------------

-- One row per back-office account, holding its email address so that a super
-- admin can see who is who. Accounts themselves are Supabase Auth users; the
-- manage-users Edge Function creates both together. (The role column is from
-- before stores existed and is no longer used for access: roles live in
-- store_members.)
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null default '',
  role text check (role in ('admin', 'super_admin')),
  created_at timestamptz not null default now()
);
alter table public.profiles alter column role drop not null;

-- Every account has a short ID that its owner can share, so that a super admin
-- can add them to a store without needing their email address. Eight letters
-- and digits, leaving out ones that look alike (0/O, 1/I/L).
create or replace function public.new_account_code()
returns text language sql volatile set search_path = '' as $$
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '')
    from generate_series(1, 8);
$$;
alter table public.profiles add column if not exists account_code text not null default public.new_account_code();
create unique index if not exists profiles_account_code_unique on public.profiles (account_code);

-- An optional name that people choose for themselves, shown beside their email.
alter table public.profiles add column if not exists display_name text not null default '' check (length(display_name) <= 80);

create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  -- The short name in the store's link, e.g. ...vercel.app/?store=main
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,29}$'),
  created_at timestamptz not null default now()
);

-- Who works at which store, and as what. One account can be in several stores.
create table if not exists public.store_members (
  store_id uuid not null references public.stores (id) on delete cascade,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  role text not null check (role in ('admin', 'super_admin')),
  created_at timestamptz not null default now(),
  primary key (store_id, user_id)
);
create index if not exists store_members_user on public.store_members (user_id);

-- The first store holds everything from before stores existed. It is also the
-- store a link without ?store= opens.
insert into public.stores (name, slug)
select 'Main store', 'main' where not exists (select 1 from public.stores);

create or replace function public.default_store_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.stores order by created_at, id limit 1;
$$;

-- Roles from before stores existed become roles in the first store. This
-- happens only once, while no store has members yet, so nobody removed from a
-- store later is put back.
insert into public.store_members (store_id, user_id, role)
select public.default_store_id(), user_id, role from public.profiles
 where role is not null and not exists (select 1 from public.store_members)
on conflict (store_id, user_id) do nothing;

-- The caller's role in a store: null when not signed in or not a member.
-- Security definer so policies can call it without going through the
-- store_members policies.
create or replace function public.store_role(p_store uuid)
returns text language sql stable security definer set search_path = '' as $$
  select role from public.store_members where store_id = p_store and user_id = (select auth.uid());
$$;

create or replace function public.is_store_member(p_store uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.store_role(p_store) is not null;
$$;

create or replace function public.is_store_super_admin(p_store uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.store_role(p_store) = 'super_admin', false);
$$;

-- Whether the caller may see someone's email: their own, or anyone in a store
-- where the caller is a super admin.
create or replace function public.can_see_profile(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_user = (select auth.uid()) or exists (
    select 1 from public.store_members them
      join public.store_members me on me.store_id = them.store_id
     where them.user_id = p_user and me.user_id = (select auth.uid()) and me.role = 'super_admin');
$$;

-- Passcodes that let someone without an account view the list of items.
create table if not exists public.access_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (length(code) between 6 and 64 and code = upper(trim(code))),
  label text not null default '',
  created_at timestamptz not null default now()
);

-- A passcode is either for viewing only or for a cashier, who can also sell.
alter table public.access_codes
  add column if not exists kind text not null default 'view' check (kind in ('view', 'cashier'));

-- Sales ---------------------------------------------------------------------------
-- A sale is made with a cashier passcode through record_sale() below. Each line
-- keeps the name, price and original price as they were at that moment, so the
-- history and the profit stay right when an item is later changed or deleted.

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  code_id uuid references public.access_codes (id) on delete set null,
  sold_by text not null default '',
  total numeric(14, 2) not null default 0,
  voided_at timestamptz,
  voided_by text
);
create index if not exists sales_created_at on public.sales (created_at desc);
alter table public.sales add column if not exists edited_at timestamptz;
alter table public.sales add column if not exists edited_by text;

create table if not exists public.sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales (id) on delete cascade,
  item_id uuid references public.items (id) on delete set null,
  name text not null,
  barcode text not null default '',
  qty integer not null check (qty > 0),
  price numeric(12, 2) not null,
  cost numeric(12, 2)
);
-- price is what the item was actually sold for; list_price is its usual price
-- at that moment, so a sale at a custom price can be told apart.
alter table public.sale_lines add column if not exists list_price numeric(12, 2);
create index if not exists sale_lines_sale_id on public.sale_lines (sale_id);

-- Which store each product, sale and passcode belongs to ----------------------------

alter table public.items add column if not exists store_id uuid references public.stores (id) on delete cascade;
alter table public.sales add column if not exists store_id uuid references public.stores (id) on delete cascade;
alter table public.access_codes add column if not exists store_id uuid references public.stores (id) on delete cascade;
update public.items set store_id = public.default_store_id() where store_id is null;
update public.sales set store_id = public.default_store_id() where store_id is null;
update public.access_codes set store_id = public.default_store_id() where store_id is null;
alter table public.items alter column store_id set not null;
alter table public.sales alter column store_id set not null;
alter table public.access_codes alter column store_id set not null;

create index if not exists items_store on public.items (store_id);
create index if not exists sales_store_created_at on public.sales (store_id, created_at desc);
create index if not exists access_codes_store on public.access_codes (store_id);

-- A barcode can belong to only one item in a store; two stores may stock the
-- same product with the same barcode. Items without a barcode are fine.
drop index if exists public.items_barcode_unique;
create unique index if not exists items_store_barcode_unique
  on public.items (store_id, barcode) where barcode <> '';

-- Access rules ------------------------------------------------------------------

alter table public.items enable row level security;
alter table public.item_photos enable row level security;
alter table public.item_costs enable row level security;
alter table public.profiles enable row level security;
alter table public.stores enable row level security;
alter table public.store_members enable row level security;
alter table public.access_codes enable row level security;
alter table public.sales enable row level security;
alter table public.sale_lines enable row level security;

-- Earlier versions' rules, which did not know about stores.
drop policy if exists "Signed-in users can use items" on public.items;
drop policy if exists "Anyone can use items" on public.items;
drop policy if exists "Staff can use items" on public.items;
drop policy if exists "Signed-in users can use item photos" on public.item_photos;
drop policy if exists "Anyone can use item photos" on public.item_photos;
drop policy if exists "Staff can use item photos" on public.item_photos;
drop policy if exists "Back office can use item costs" on public.item_costs;
drop policy if exists "Super admin can use item costs" on public.item_costs;
drop policy if exists "Staff can use item costs" on public.item_costs;
drop policy if exists "Read own profile or all as super admin" on public.profiles;
drop policy if exists "Super admin can change other roles" on public.profiles;
drop policy if exists "Super admin can use passcodes" on public.access_codes;
drop policy if exists "Staff can use passcodes" on public.access_codes;
drop policy if exists "Staff can read sales" on public.sales;
drop policy if exists "Staff can read sale lines" on public.sale_lines;

drop policy if exists "Store staff can use items" on public.items;
create policy "Store staff can use items" on public.items
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));

drop policy if exists "Store staff can use item photos" on public.item_photos;
create policy "Store staff can use item photos" on public.item_photos
  for all to authenticated
  using (exists (select 1 from public.items i where i.id = item_id and public.is_store_member(i.store_id)))
  with check (exists (select 1 from public.items i where i.id = item_id and public.is_store_member(i.store_id)));

drop policy if exists "Store staff can use item costs" on public.item_costs;
create policy "Store staff can use item costs" on public.item_costs
  for all to authenticated
  using (exists (select 1 from public.items i where i.id = item_id and public.is_store_member(i.store_id)))
  with check (exists (select 1 from public.items i where i.id = item_id and public.is_store_member(i.store_id)));

drop policy if exists "See own profile or your store's people" on public.profiles;
create policy "See own profile or your store's people" on public.profiles
  for select to authenticated using (public.can_see_profile(user_id));

-- Everyone can change their own display name (and nothing else about the profile).
drop policy if exists "Update own display name" on public.profiles;
create policy "Update own display name" on public.profiles
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "Members can see their stores" on public.stores;
create policy "Members can see their stores" on public.stores
  for select to authenticated using (public.is_store_member(id));

drop policy if exists "Super admin can rename the store" on public.stores;
create policy "Super admin can rename the store" on public.stores
  for update to authenticated using (public.is_store_super_admin(id)) with check (public.is_store_super_admin(id));

drop policy if exists "See own memberships or your store's people" on public.store_members;
create policy "See own memberships or your store's people" on public.store_members
  for select to authenticated using (user_id = (select auth.uid()) or public.is_store_super_admin(store_id));

-- A super admin can change other people's roles in their store, never their
-- own, so every store keeps at least one super admin.
drop policy if exists "Super admin can change other roles in the store" on public.store_members;
create policy "Super admin can change other roles in the store" on public.store_members
  for update to authenticated
  using (public.is_store_super_admin(store_id) and user_id <> (select auth.uid()))
  with check (public.is_store_super_admin(store_id) and user_id <> (select auth.uid()));

drop policy if exists "Store staff can use passcodes" on public.access_codes;
create policy "Store staff can use passcodes" on public.access_codes
  for all to authenticated using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));

-- Store staff can read their sales. Nobody writes them directly: record_sale(),
-- edit_sale() and void_sale() below are the only way in.
drop policy if exists "Store staff can read sales" on public.sales;
create policy "Store staff can read sales" on public.sales
  for select to authenticated using (public.is_store_member(store_id));

drop policy if exists "Store staff can read sale lines" on public.sale_lines;
create policy "Store staff can read sale lines" on public.sale_lines
  for select to authenticated
  using (exists (select 1 from public.sales s where s.id = sale_id and public.is_store_member(s.store_id)));

revoke all on public.sales, public.sale_lines from anon, authenticated;
grant select on public.sales, public.sale_lines to authenticated;

revoke all on public.items, public.item_photos, public.item_costs, public.profiles, public.stores,
  public.store_members, public.access_codes from anon;
grant select, insert, update, delete on public.items, public.item_photos, public.item_costs, public.access_codes to authenticated;
revoke all on public.profiles, public.stores, public.store_members from authenticated;
grant select, update (display_name) on public.profiles to authenticated;
grant select, update (name) on public.stores to authenticated;
grant select, update (role) on public.store_members to authenticated;

revoke all on function public.store_role(uuid), public.is_store_member(uuid), public.is_store_super_admin(uuid),
  public.can_see_profile(uuid) from public, anon;
grant execute on function public.store_role(uuid), public.is_store_member(uuid), public.is_store_super_admin(uuid),
  public.can_see_profile(uuid) to authenticated;
revoke all on function public.default_store_id() from public, anon, authenticated;
revoke all on function public.new_account_code() from public, anon, authenticated;

-- Creates another store. Any super admin may, and becomes its super admin.
create or replace function public.create_store(p_name text, p_slug text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_slug text := lower(trim(coalesce(p_slug, '')));
  v_name text := trim(coalesce(p_name, ''));
  v_store public.stores%rowtype;
begin
  if not exists (select 1 from public.store_members where user_id = (select auth.uid()) and role = 'super_admin') then
    raise exception 'Only a super admin can create a store.' using errcode = '42501';
  end if;
  if length(v_name) not between 1 and 80 then
    raise exception 'Give the store a name.' using errcode = 'P0001';
  end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,29}$' then
    raise exception 'The short name must be 2 to 30 lower-case letters, numbers or dashes.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.stores where slug = v_slug) then
    raise exception 'Another store already uses that short name.' using errcode = 'P0001';
  end if;
  insert into public.stores (name, slug) values (v_name, v_slug) returning * into v_store;
  insert into public.store_members (store_id, user_id, role) values (v_store.id, (select auth.uid()), 'super_admin');
  return jsonb_build_object('id', v_store.id, 'name', v_store.name, 'slug', v_store.slug);
end $$;

revoke all on function public.create_store(text, text) from public, anon;
grant execute on function public.create_store(text, text) to authenticated;

-- Functions from before stores existed, no longer used.
drop function if exists public.is_staff();
drop function if exists public.is_super_admin();
drop function if exists public.my_role();

-- What people without an account can do -------------------------------------------
-- These functions are the only way in for them. Each returns JSON so the app
-- gets everything in one call.

-- Wrong tries, so that guessing can be slowed down: one counter per address
-- (passcodes) or per email address (sign-ins). A counter covers a 15-minute
-- window and starts again after it, so nothing ever needs cleaning up. Only
-- the functions below touch this table.
create table if not exists public.attempt_counters (
  kind text not null check (kind in ('passcode', 'login')),
  who text not null,
  failed integer not null default 0,
  window_start timestamptz not null default now(),
  primary key (kind, who)
);
alter table public.attempt_counters enable row level security;
revoke all on public.attempt_counters from anon, authenticated;

-- Earlier versions kept a row per wrong try in these tables.
drop table if exists public.code_attempts;
drop table if exists public.login_attempts;

-- The caller's address as the API gateway reports it ('unknown' when it does not).
create or replace function public.caller_ip()
returns text language sql stable set search_path = '' as $$
  select coalesce(
    nullif(h ->> 'cf-connecting-ip', ''),
    nullif(trim(split_part(h ->> 'x-forwarded-for', ',', 1)), ''),
    'unknown')
  from (select coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json as h) x;
$$;

-- Adds one wrong try, starting a new 15-minute window if the last one is over.
create or replace function public.count_failure(p_kind text, p_who text)
returns void language sql security definer set search_path = '' as $$
  insert into public.attempt_counters as c (kind, who, failed, window_start)
  values (p_kind, p_who, 1, now())
  on conflict (kind, who) do update set
    failed = case when c.window_start < now() - interval '15 minutes' then 1 else c.failed + 1 end,
    window_start = case when c.window_start < now() - interval '15 minutes' then now() else c.window_start end;
$$;

-- Where a counter stands: wrong tries in the current window, whether it is
-- resting (10 or more), and for how many more seconds.
create or replace function public.attempt_standing(p_kind text, p_who text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'failed', coalesce(max(failed), 0),
    'locked', coalesce(max(failed), 0) >= 10,
    'wait_seconds', case when coalesce(max(failed), 0) >= 10
      then greatest(0, ceil(extract(epoch from (max(window_start) + interval '15 minutes' - now()))))::integer
      else 0 end)
  from public.attempt_counters
  where kind = p_kind and who = p_who and window_start > now() - interval '15 minutes';
$$;

-- Looks a passcode up. Returns its row, or a row of nulls when it is wrong.
-- After 10 wrong passcodes from one address in 15 minutes, that address is
-- refused for the rest of the 15 minutes, right passcode or not. A wrong
-- passcode is reported by returning null rather than raising, because raising
-- would undo the count.
create or replace function public.use_access_code(p_code text)
returns public.access_codes language plpgsql security definer set search_path = '' as $$
declare
  v_ip text := public.caller_ip();
  v_row public.access_codes%rowtype;
begin
  if v_ip <> 'unknown' and (public.attempt_standing('passcode', v_ip) ->> 'locked')::boolean then
    raise exception 'Too many wrong passcodes. Wait 15 minutes and try again.' using errcode = 'P0001';
  end if;
  select * into v_row from public.access_codes where code = upper(trim(coalesce(p_code, '')));
  if found then
    return v_row;
  end if;
  perform public.count_failure('passcode', v_ip);
  return null;
end $$;

-- Sign-in: an account rests for 15 minutes after 10 wrong passwords. (Supabase
-- Auth applies its own limits to sign-in requests as well; this adds a count
-- per account, which the back office checks before and after each try.)
create or replace function public.login_status(p_email text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.attempt_standing('login', lower(trim(coalesce(p_email, ''))));
$$;

-- Counts one wrong password for an email address and returns its new standing.
create or replace function public.login_failed(p_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  if v_email <> '' and length(v_email) <= 320
     and not (public.attempt_standing('login', v_email) ->> 'locked')::boolean then
    perform public.count_failure('login', v_email);
  end if;
  return public.attempt_standing('login', v_email);
end $$;

-- Clears the count for the account that has just signed in.
create or replace function public.login_succeeded()
returns void language sql security definer set search_path = '' as $$
  update public.attempt_counters set failed = 0
   where kind = 'login' and who = lower(coalesce((select auth.jwt()) ->> 'email', ''));
$$;

revoke all on function public.count_failure(text, text), public.attempt_standing(text, text) from public, anon, authenticated;
revoke all on function public.login_status(text), public.login_failed(text) from public;
grant execute on function public.login_status(text), public.login_failed(text) to anon, authenticated;
revoke all on function public.login_succeeded() from public, anon;
grant execute on function public.login_succeeded() to authenticated;

-- A store as the public may see it: its name and short name. p_store is the
-- short name from the link; blank means the first store. Null when unknown.
create or replace function public.store_info(p_store text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', s.id, 'name', s.name, 'slug', s.slug)
    from public.stores s
   where case when trim(coalesce(p_store, '')) = '' then s.id = public.default_store_id()
              else s.slug = lower(trim(p_store)) end;
$$;

-- One item of a store by its exact barcode, with its photo. Null when there is none.
drop function if exists public.lookup_item(text);
create or replace function public.lookup_item(p_store text, p_barcode text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(x) from (
    select i.id, i.barcode, i.name, i.description, i.price, i.qty,
           i.photo_updated_at, i.updated_at, p.data as photo
      from public.items i
      left join public.item_photos p on p.item_id = i.id
     where trim(coalesce(p_barcode, '')) <> ''
       and i.barcode = trim(p_barcode)
       and i.store_id = (public.store_info(p_store) ->> 'id')::uuid
     limit 1
  ) x;
$$;

create or replace function public.access_code_ok(p_code text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.access_codes where code = upper(trim(coalesce(p_code, ''))));
$$;

-- The whole list of items, for someone holding a valid passcode. Null when
-- the passcode is wrong.
create or replace function public.list_items_with_code(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_code public.access_codes%rowtype := public.use_access_code(p_code);
begin
  if v_code.id is null then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x)) from (
      select id, barcode, name, description, price, qty, photo_updated_at, updated_at
        from public.items where store_id = v_code.store_id order by id
    ) x
  ), '[]'::jsonb);
end $$;

-- Photos for up to 20 items at a time, for someone holding a valid passcode.
create or replace function public.item_photos_with_code(p_code text, p_ids uuid[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_code public.access_codes%rowtype := public.use_access_code(p_code);
begin
  if v_code.id is null then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('item_id', p.item_id, 'data', p.data))
      from public.item_photos p
      join public.items i on i.id = p.item_id
     where p.item_id = any (p_ids[1:20]) and i.store_id = v_code.store_id
  ), '[]'::jsonb);
end $$;

revoke all on function public.access_code_ok(text), public.use_access_code(text), public.caller_ip() from public, anon, authenticated;
revoke all on function public.items_touch_updated_at() from public, anon, authenticated;
revoke all on function public.store_info(text), public.lookup_item(text, text), public.list_items_with_code(text), public.item_photos_with_code(text, uuid[]) from public;
grant execute on function public.store_info(text), public.lookup_item(text, text), public.list_items_with_code(text), public.item_photos_with_code(text, uuid[]) to anon, authenticated;

-- What kind of passcode this is: 'view', 'cashier', or null when it is not valid.
create or replace function public.access_code_kind(p_code text)
returns text language sql volatile security definer set search_path = '' as $$
  select (public.use_access_code(p_code)).kind;
$$;

-- What a passcode opens: its kind and its store. Null when it is not valid.
create or replace function public.access_code_info(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_code public.access_codes%rowtype := public.use_access_code(p_code);
begin
  if v_code.id is null then
    return null;
  end if;
  return (select jsonb_build_object('kind', v_code.kind,
                                    'store', jsonb_build_object('id', s.id, 'name', s.name, 'slug', s.slug))
            from public.stores s where s.id = v_code.store_id);
end $$;

-- True when the caller typed their password within the last 10 minutes. Used
-- to make changing or cancelling a sale need a fresh password, not just an
-- open session. (A token carries the time of each sign-in in its "amr" claim.)
create or replace function public.password_recent()
returns boolean language sql stable set search_path = '' as $$
  select coalesce((
    select max((e ->> 'timestamp')::bigint)
      from jsonb_array_elements(coalesce((select auth.jwt()) -> 'amr', '[]'::jsonb)) e
     where e ->> 'method' = 'password'
  ), 0) > extract(epoch from now()) - 600;
$$;

-- Records a sale made with a cashier passcode and takes the items out of stock.
-- p_lines is a JSON array of {"item_id": "...", "qty": 2}. A line may add
-- "price" to sell at a custom price; otherwise the item's own price is used.
-- Both prices are recorded. Nothing is sold beyond what is in stock. Returns
-- null when the passcode is not a cashier's.
create or replace function public.record_sale(p_code text, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code public.access_codes%rowtype;
  v_sale_id uuid := gen_random_uuid();
  v_total numeric(14, 2) := 0;
  v_line record;
  v_item public.items%rowtype;
  v_price numeric(12, 2);
begin
  v_code := public.use_access_code(p_code);
  if v_code.id is null or v_code.kind <> 'cashier' then
    return null; -- not a cashier passcode
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'The cart is empty.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'That is too many items for one sale.' using errcode = 'P0001';
  end if;

  insert into public.sales (id, store_id, code_id, sold_by)
  values (v_sale_id, v_code.store_id, v_code.id, coalesce(nullif(trim(v_code.label), ''), 'Cashier'));

  -- The same item twice in the cart counts once; a fixed order avoids two
  -- sales locking each other.
  for v_line in
    select (l ->> 'item_id')::uuid as item_id, sum((l ->> 'qty')::integer)::integer as qty,
           max((l ->> 'price')::numeric) as custom_price
      from jsonb_array_elements(p_lines) l
     group by 1 order by 1
  loop
    if v_line.item_id is null or v_line.qty is null or v_line.qty <= 0 then
      raise exception 'Every quantity must be 1 or more.' using errcode = 'P0001';
    end if;
    select * into v_item from public.items where id = v_line.item_id and store_id = v_code.store_id for update;
    if not found then
      raise exception 'An item in the cart no longer exists. Remove it and try again.' using errcode = 'P0001';
    end if;
    if v_item.qty < v_line.qty then
      raise exception 'Only % left of "%".', v_item.qty, v_item.name using errcode = 'P0001';
    end if;
    if v_line.custom_price is not null and (v_line.custom_price < 0 or v_line.custom_price > 9999999999) then
      raise exception 'The price for "%" is not valid.', v_item.name using errcode = 'P0001';
    end if;
    v_price := round(coalesce(v_line.custom_price, v_item.price), 2);
    update public.items set qty = qty - v_line.qty where id = v_item.id;
    insert into public.sale_lines (sale_id, item_id, name, barcode, qty, price, list_price, cost)
    values (v_sale_id, v_item.id, v_item.name, v_item.barcode, v_line.qty, v_price, v_item.price,
            (select c.cost from public.item_costs c where c.item_id = v_item.id));
    v_total := v_total + v_price * v_line.qty;
  end loop;

  update public.sales set total = v_total where id = v_sale_id;
  return jsonb_build_object('sale_id', v_sale_id, 'total', v_total);
end $$;

-- Cancels a sale and puts its items back in stock. Staff of the sale's store only.
create or replace function public.void_sale(p_sale_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_sale public.sales%rowtype;
begin
  if not public.password_recent() then
    raise exception 'Enter your password to confirm this change.' using errcode = 'P0001';
  end if;
  -- Only staff of the sale's own store; anyone else is told it does not exist.
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or not public.is_store_member(v_sale.store_id) then
    raise exception 'That sale no longer exists.' using errcode = 'P0001';
  end if;
  if v_sale.voided_at is not null then
    raise exception 'That sale was already cancelled.' using errcode = 'P0001';
  end if;
  update public.items i set qty = i.qty + l.qty
    from (select item_id, sum(qty)::integer as qty from public.sale_lines
           where sale_id = p_sale_id and item_id is not null group by item_id) l
   where i.id = l.item_id;
  update public.sales
     set voided_at = now(),
         voided_by = coalesce((select email from public.profiles where user_id = (select auth.uid())), '')
   where id = p_sale_id;
end $$;

-- Corrects a sale after the fact. Staff of the sale's store only. p_lines is a JSON array of
-- {"line_id": "...", "qty": 2, "price": 100}; a line left out stays as it is,
-- and qty 0 removes it. Stock follows the change: selling fewer puts items
-- back, selling more takes them out (and is refused if there are not enough).
create or replace function public.edit_sale(p_sale_id uuid, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sale public.sales%rowtype;
  v_line public.sale_lines%rowtype;
  v_edit record;
  v_stock integer;
  v_delta integer;
  v_total numeric(14, 2);
begin
  if not public.password_recent() then
    raise exception 'Enter your password to confirm this change.' using errcode = 'P0001';
  end if;
  -- Only staff of the sale's own store; anyone else is told it does not exist.
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or not public.is_store_member(v_sale.store_id) then
    raise exception 'That sale no longer exists.' using errcode = 'P0001';
  end if;
  if v_sale.voided_at is not null then
    raise exception 'A cancelled sale cannot be edited.' using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Nothing to change.' using errcode = 'P0001';
  end if;

  for v_edit in
    select (l ->> 'line_id')::uuid as line_id, (l ->> 'qty')::integer as qty, (l ->> 'price')::numeric as price
      from jsonb_array_elements(p_lines) l
     order by 1
  loop
    select * into v_line from public.sale_lines where id = v_edit.line_id and sale_id = p_sale_id for update;
    if not found then
      raise exception 'A line of this sale no longer exists. Reload and try again.' using errcode = 'P0001';
    end if;
    if v_edit.qty is null or v_edit.qty < 0 then
      raise exception 'Every quantity must be 0 or more.' using errcode = 'P0001';
    end if;
    if v_edit.price is null or v_edit.price < 0 or v_edit.price > 9999999999 then
      raise exception 'The price for "%" is not valid.', v_line.name using errcode = 'P0001';
    end if;

    v_delta := v_edit.qty - v_line.qty; -- more sold (positive) or fewer (negative)
    if v_delta <> 0 then
      if v_line.item_id is null then
        if v_delta > 0 then
          raise exception '"%" has been deleted, so more of it cannot be added to the sale.', v_line.name using errcode = 'P0001';
        end if;
      else
        select qty into v_stock from public.items where id = v_line.item_id for update;
        if v_delta > v_stock then
          raise exception 'Only % more of "%" in stock.', v_stock, v_line.name using errcode = 'P0001';
        end if;
        update public.items set qty = qty - v_delta where id = v_line.item_id;
      end if;
    end if;

    if v_edit.qty = 0 then
      delete from public.sale_lines where id = v_line.id;
    else
      update public.sale_lines set qty = v_edit.qty, price = round(v_edit.price, 2) where id = v_line.id;
    end if;
  end loop;

  select sum(price * qty) into v_total from public.sale_lines where sale_id = p_sale_id;
  if v_total is null then
    raise exception 'A sale needs at least one item. Cancel the sale instead.' using errcode = 'P0001';
  end if;
  update public.sales
     set total = v_total,
         edited_at = now(),
         edited_by = coalesce((select email from public.profiles where user_id = (select auth.uid())), '')
   where id = p_sale_id;
  return jsonb_build_object('sale_id', p_sale_id, 'total', v_total);
end $$;

revoke all on function public.password_recent() from public, anon;
grant execute on function public.password_recent() to authenticated;
revoke all on function public.edit_sale(uuid, jsonb) from public, anon;
grant execute on function public.edit_sale(uuid, jsonb) to authenticated;

revoke all on function public.access_code_kind(text), public.access_code_info(text), public.record_sale(text, jsonb) from public;
grant execute on function public.access_code_kind(text), public.access_code_info(text), public.record_sale(text, jsonb) to anon, authenticated;
revoke all on function public.void_sale(uuid) from public, anon;
grant execute on function public.void_sale(uuid) to authenticated;


-- Quantity +/- that stays correct when two people tap at the same time ----------
-- Runs with the caller's rights, so only staff can change stock.

create or replace function public.adjust_qty(p_id uuid, p_delta integer)
returns integer language sql security invoker set search_path = '' as $$
  update public.items
     set qty = greatest(0, qty + p_delta)
   where id = p_id
  returning qty;
$$;

revoke all on function public.adjust_qty(uuid, integer) from public, anon;
grant execute on function public.adjust_qty(uuid, integer) to authenticated;

-- Live updates: signed-in staff see changes without reloading --------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'items'
  ) then
    alter publication supabase_realtime add table public.items;
  end if;
end $$;

-- The first super admin -----------------------------------------------------------
-- While nobody belongs to any store and there is exactly one account, that
-- account becomes the first store's super admin. To pick one yourself, run:
--   insert into public.profiles (user_id, email) select id, email from auth.users
--    where email = 'you@example.com' on conflict do nothing;
--   insert into public.store_members (store_id, user_id, role)
--   select public.default_store_id(), id, 'super_admin' from auth.users where email = 'you@example.com';

insert into public.profiles (user_id, email)
select u.id, coalesce(u.email, '') from auth.users u
 where not exists (select 1 from public.store_members)
   and (select count(*) from auth.users) = 1
on conflict (user_id) do nothing;

insert into public.store_members (store_id, user_id, role)
select public.default_store_id(), p.user_id, 'super_admin' from public.profiles p
 where not exists (select 1 from public.store_members)
   and (select count(*) from auth.users) = 1;
