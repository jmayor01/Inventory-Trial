-- Inventory: database setup for Supabase.
-- Paste this whole file into Supabase > SQL Editor and press Run.
-- It is safe to run more than once.
--
-- Who can do what (enforced here, not just in the app):
--   Nobody signed in  -> look up one item by its exact barcode
--   With a passcode   -> also view the whole list of items
--   Admin             -> add, change and delete items, change stock, import
--   Super admin       -> everything an admin can, plus original prices and
--                        profit, user accounts and passcodes

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

-- A barcode can belong to only one item (items without a barcode are fine).
create unique index if not exists items_barcode_unique
  on public.items (barcode) where barcode <> '';

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

-- Original (cost) prices, kept apart from items so that only the super admin
-- can read them. Profit is worked out from these.
create table if not exists public.item_costs (
  item_id uuid primary key references public.items (id) on delete cascade,
  cost numeric(12, 2) not null check (cost >= 0),
  updated_at timestamptz not null default now()
);

-- Roles -------------------------------------------------------------------------

-- One row per account that may use the back office. Accounts themselves are
-- Supabase Auth users; the manage-users Edge Function creates both together.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null default '',
  role text not null check (role in ('admin', 'super_admin')),
  created_at timestamptz not null default now()
);

-- The role of whoever is making the request (null when not signed in or when
-- the account has no role). Security definer so policies can call it without
-- reading profiles through its own policies.
create or replace function public.my_role()
returns text language sql stable security definer set search_path = '' as $$
  select role from public.profiles where user_id = (select auth.uid());
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.my_role() in ('admin', 'super_admin'), false);
$$;

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.my_role() = 'super_admin', false);
$$;

-- Passcodes that let someone without an account view the list of items.
create table if not exists public.access_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (length(code) between 6 and 64 and code = upper(trim(code))),
  label text not null default '',
  created_at timestamptz not null default now()
);

-- Access rules ------------------------------------------------------------------

alter table public.items enable row level security;
alter table public.item_photos enable row level security;
alter table public.item_costs enable row level security;
alter table public.profiles enable row level security;
alter table public.access_codes enable row level security;

drop policy if exists "Signed-in users can use items" on public.items;
drop policy if exists "Anyone can use items" on public.items;
drop policy if exists "Staff can use items" on public.items;
create policy "Staff can use items" on public.items
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists "Signed-in users can use item photos" on public.item_photos;
drop policy if exists "Anyone can use item photos" on public.item_photos;
drop policy if exists "Staff can use item photos" on public.item_photos;
create policy "Staff can use item photos" on public.item_photos
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists "Back office can use item costs" on public.item_costs;
drop policy if exists "Super admin can use item costs" on public.item_costs;
create policy "Super admin can use item costs" on public.item_costs
  for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists "Read own profile or all as super admin" on public.profiles;
create policy "Read own profile or all as super admin" on public.profiles
  for select to authenticated using (user_id = (select auth.uid()) or public.is_super_admin());

-- A super admin can change other people's roles, never their own, so there is
-- always at least one super admin left.
drop policy if exists "Super admin can change other roles" on public.profiles;
create policy "Super admin can change other roles" on public.profiles
  for update to authenticated
  using (public.is_super_admin() and user_id <> (select auth.uid()))
  with check (public.is_super_admin() and user_id <> (select auth.uid()));

drop policy if exists "Super admin can use passcodes" on public.access_codes;
create policy "Super admin can use passcodes" on public.access_codes
  for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

revoke all on public.items, public.item_photos, public.item_costs, public.profiles, public.access_codes from anon;
grant select, insert, update, delete on public.items, public.item_photos, public.item_costs, public.access_codes to authenticated;
revoke all on public.profiles from authenticated;
grant select, update (role) on public.profiles to authenticated;

-- What people without an account can do -------------------------------------------
-- These functions are the only way in for them. Each returns JSON so the app
-- gets everything in one call.

-- One item by its exact barcode, with its photo. Null when there is none.
create or replace function public.lookup_item(p_barcode text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(x) from (
    select i.id, i.barcode, i.name, i.description, i.price, i.qty,
           i.photo_updated_at, i.updated_at, p.data as photo
      from public.items i
      left join public.item_photos p on p.item_id = i.id
     where trim(coalesce(p_barcode, '')) <> ''
       and i.barcode = trim(p_barcode)
     limit 1
  ) x;
$$;

create or replace function public.access_code_ok(p_code text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.access_codes where code = upper(trim(coalesce(p_code, ''))));
$$;

-- The whole list of items, for someone holding a valid passcode.
create or replace function public.list_items_with_code(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.access_code_ok(p_code) then
    raise exception 'invalid passcode' using errcode = '28000';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x)) from (
      select id, barcode, name, description, price, qty, photo_updated_at, updated_at
        from public.items order by id
    ) x
  ), '[]'::jsonb);
end $$;

-- Photos for up to 20 items at a time, for someone holding a valid passcode.
create or replace function public.item_photos_with_code(p_code text, p_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.access_code_ok(p_code) then
    raise exception 'invalid passcode' using errcode = '28000';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('item_id', p.item_id, 'data', p.data))
      from public.item_photos p
     where p.item_id = any (p_ids[1:20])
  ), '[]'::jsonb);
end $$;

revoke all on function public.my_role(), public.is_staff(), public.is_super_admin() from public, anon;
grant execute on function public.my_role(), public.is_staff(), public.is_super_admin() to authenticated;
revoke all on function public.access_code_ok(text) from public, anon, authenticated;
revoke all on function public.lookup_item(text), public.list_items_with_code(text), public.item_photos_with_code(text, uuid[]) from public;
grant execute on function public.lookup_item(text), public.list_items_with_code(text), public.item_photos_with_code(text, uuid[]) to anon, authenticated;

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
-- While nobody has a role yet and there is exactly one account, that account
-- becomes the super admin. To pick one yourself instead, run:
--   insert into public.profiles (user_id, email, role)
--   select id, email, 'super_admin' from auth.users where email = 'you@example.com';

insert into public.profiles (user_id, email, role)
select u.id, coalesce(u.email, ''), 'super_admin'
  from auth.users u
 where not exists (select 1 from public.profiles)
   and (select count(*) from auth.users) = 1;
