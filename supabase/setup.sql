-- Inventory: database setup for Supabase.
-- Paste this whole file into Supabase > SQL Editor and press Run.
-- It is safe to run more than once.

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

-- Access: signed-in users only --------------------------------------------------

alter table public.items enable row level security;
alter table public.item_photos enable row level security;

drop policy if exists "Signed-in users can use items" on public.items;
create policy "Signed-in users can use items" on public.items
  for all to authenticated using (true) with check (true);

drop policy if exists "Signed-in users can use item photos" on public.item_photos;
create policy "Signed-in users can use item photos" on public.item_photos
  for all to authenticated using (true) with check (true);

revoke all on public.items, public.item_photos from anon;
grant select, insert, update, delete on public.items, public.item_photos to authenticated;

-- Quantity +/- that stays correct when two people tap at the same time ----------

create or replace function public.adjust_qty(p_id uuid, p_delta integer)
returns integer language sql security invoker set search_path = '' as $$
  update public.items
     set qty = greatest(0, qty + p_delta)
   where id = p_id
  returning qty;
$$;

revoke all on function public.adjust_qty(uuid, integer) from public, anon;
grant execute on function public.adjust_qty(uuid, integer) to authenticated;

-- Live updates: other phones see changes without reloading ----------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'items'
  ) then
    alter publication supabase_realtime add table public.items;
  end if;
end $$;
