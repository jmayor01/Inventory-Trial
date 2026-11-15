-- Inventory: database setup for Supabase.
-- Paste this whole file into Supabase > SQL Editor and press Run.
-- It is safe to run more than once.
--
-- Who can do what (enforced here, not just in the app):
--   Nobody signed in  -> look up one item by its exact barcode
--   With a passcode   -> also view the whole list of items
--   Cashier passcode  -> also sell: take items out of stock through a recorded sale
--   Admin             -> add, change and delete items, change stock, import,
--                        original prices and profit, passcodes
--   Super admin       -> everything an admin can, plus user accounts

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

-- Original (cost) prices, kept apart from items so that only signed-in staff
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

-- Access rules ------------------------------------------------------------------

alter table public.items enable row level security;
alter table public.item_photos enable row level security;
alter table public.item_costs enable row level security;
alter table public.profiles enable row level security;
alter table public.access_codes enable row level security;
alter table public.sales enable row level security;
alter table public.sale_lines enable row level security;

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
drop policy if exists "Staff can use item costs" on public.item_costs;
create policy "Staff can use item costs" on public.item_costs
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

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
drop policy if exists "Staff can use passcodes" on public.access_codes;
create policy "Staff can use passcodes" on public.access_codes
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- Staff can read sales. Nobody writes them directly: record_sale() and
-- void_sale() below are the only way in.
drop policy if exists "Staff can read sales" on public.sales;
create policy "Staff can read sales" on public.sales
  for select to authenticated using (public.is_staff());

drop policy if exists "Staff can read sale lines" on public.sale_lines;
create policy "Staff can read sale lines" on public.sale_lines
  for select to authenticated using (public.is_staff());

revoke all on public.sales, public.sale_lines from anon, authenticated;
grant select on public.sales, public.sale_lines to authenticated;

revoke all on public.items, public.item_photos, public.item_costs, public.profiles, public.access_codes from anon;
grant select, insert, update, delete on public.items, public.item_photos, public.item_costs, public.access_codes to authenticated;
revoke all on public.profiles from authenticated;
grant select, update (role) on public.profiles to authenticated;

-- What people without an account can do -------------------------------------------
-- These functions are the only way in for them. Each returns JSON so the app
-- gets everything in one call.

-- Wrong passcode guesses, so that guessing can be slowed down. Only the
-- functions below touch this table.
create table if not exists public.code_attempts (
  ip text not null,
  at timestamptz not null default now()
);
create index if not exists code_attempts_ip_at on public.code_attempts (ip, at);
alter table public.code_attempts enable row level security;
revoke all on public.code_attempts from anon, authenticated;

-- The caller's address as the API gateway reports it ('unknown' when it does not).
create or replace function public.caller_ip()
returns text language sql stable set search_path = '' as $$
  select coalesce(
    nullif(h ->> 'cf-connecting-ip', ''),
    nullif(trim(split_part(h ->> 'x-forwarded-for', ',', 1)), ''),
    'unknown')
  from (select coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json as h) x;
$$;

-- Looks a passcode up. Returns its row, or a row of nulls when it is wrong.
-- After 10 wrong guesses from one address in 15 minutes, that address is
-- refused for the rest of the 15 minutes, right passcode or not. Wrong guesses
-- are reported by returning null rather than raising, because raising would
-- undo the record of the guess.
create or replace function public.use_access_code(p_code text)
returns public.access_codes language plpgsql security definer set search_path = '' as $$
declare
  v_ip text := public.caller_ip();
  v_row public.access_codes%rowtype;
begin
  if v_ip <> 'unknown' and (
    select count(*) from public.code_attempts where ip = v_ip and at > now() - interval '15 minutes'
  ) >= 10 then
    raise exception 'Too many wrong passcodes. Wait 15 minutes and try again.' using errcode = 'P0001';
  end if;
  select * into v_row from public.access_codes where code = upper(trim(coalesce(p_code, '')));
  if found then
    return v_row;
  end if;
  insert into public.code_attempts (ip) values (v_ip);
  delete from public.code_attempts where at < now() - interval '1 day';
  return null;
end $$;

-- Wrong passwords at the sign-in screen, per email address, so that the app
-- can make an account rest after 10 of them. (Supabase Auth applies its own
-- limits to sign-in requests as well; this adds a per-account count.)
create table if not exists public.login_attempts (
  email text not null,
  at timestamptz not null default now()
);
create index if not exists login_attempts_email_at on public.login_attempts (email, at);
alter table public.login_attempts enable row level security;
revoke all on public.login_attempts from anon, authenticated;

-- How an email address stands: wrong passwords in the last 15 minutes, whether
-- it is resting, and for how many more seconds. It rests once there are 10,
-- until the oldest of those 10 is 15 minutes old.
create or replace function public.login_status(p_email text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'failed', count(*),
    'locked', count(*) >= 10,
    'wait_seconds', case when count(*) >= 10
      then greatest(0, ceil(extract(epoch from (min(at) + interval '15 minutes' - now()))))::integer
      else 0 end)
  from (
    select at from public.login_attempts
     where email = lower(trim(coalesce(p_email, ''))) and at > now() - interval '15 minutes'
     order by at desc limit 10
  ) recent;
$$;

-- Counts one wrong password for an email address and returns its new standing.
create or replace function public.login_failed(p_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  if v_email <> '' and length(v_email) <= 320 and not (public.login_status(v_email) ->> 'locked')::boolean then
    insert into public.login_attempts (email) values (v_email);
  end if;
  delete from public.login_attempts where at < now() - interval '1 day';
  return public.login_status(v_email);
end $$;

-- Clears the count for the account that has just signed in.
create or replace function public.login_succeeded()
returns void language sql security definer set search_path = '' as $$
  delete from public.login_attempts where email = lower(coalesce((select auth.jwt()) ->> 'email', ''));
$$;

revoke all on function public.login_status(text), public.login_failed(text) from public;
grant execute on function public.login_status(text), public.login_failed(text) to anon, authenticated;
revoke all on function public.login_succeeded() from public, anon;
grant execute on function public.login_succeeded() to authenticated;

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

-- The whole list of items, for someone holding a valid passcode. Null when
-- the passcode is wrong.
create or replace function public.list_items_with_code(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if (public.use_access_code(p_code)).id is null then
    return null;
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
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if (public.use_access_code(p_code)).id is null then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('item_id', p.item_id, 'data', p.data))
      from public.item_photos p
     where p.item_id = any (p_ids[1:20])
  ), '[]'::jsonb);
end $$;

revoke all on function public.my_role(), public.is_staff(), public.is_super_admin() from public, anon;
grant execute on function public.my_role(), public.is_staff(), public.is_super_admin() to authenticated;
revoke all on function public.access_code_ok(text), public.use_access_code(text), public.caller_ip() from public, anon, authenticated;
revoke all on function public.items_touch_updated_at() from public, anon, authenticated;
revoke all on function public.lookup_item(text), public.list_items_with_code(text), public.item_photos_with_code(text, uuid[]) from public;
grant execute on function public.lookup_item(text), public.list_items_with_code(text), public.item_photos_with_code(text, uuid[]) to anon, authenticated;

-- What kind of passcode this is: 'view', 'cashier', or null when it is not valid.
create or replace function public.access_code_kind(p_code text)
returns text language sql volatile security definer set search_path = '' as $$
  select (public.use_access_code(p_code)).kind;
$$;

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

  insert into public.sales (id, code_id, sold_by)
  values (v_sale_id, v_code.id, coalesce(nullif(trim(v_code.label), ''), 'Cashier'));

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
    select * into v_item from public.items where id = v_line.item_id for update;
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

-- Cancels a sale and puts its items back in stock. Staff only.
create or replace function public.void_sale(p_sale_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_sale public.sales%rowtype;
begin
  if not public.is_staff() then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if not public.password_recent() then
    raise exception 'Enter your password to confirm this change.' using errcode = 'P0001';
  end if;
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
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

-- Corrects a sale after the fact. Staff only. p_lines is a JSON array of
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
  if not public.is_staff() then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if not public.password_recent() then
    raise exception 'Enter your password to confirm this change.' using errcode = 'P0001';
  end if;
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
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

revoke all on function public.access_code_kind(text), public.record_sale(text, jsonb) from public;
grant execute on function public.access_code_kind(text), public.record_sale(text, jsonb) to anon, authenticated;
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
-- While nobody has a role yet and there is exactly one account, that account
-- becomes the super admin. To pick one yourself instead, run:
--   insert into public.profiles (user_id, email, role)
--   select id, email, 'super_admin' from auth.users where email = 'you@example.com';

insert into public.profiles (user_id, email, role)
select u.id, coalesce(u.email, ''), 'super_admin'
  from auth.users u
 where not exists (select 1 from public.profiles)
   and (select count(*) from auth.users) = 1;
