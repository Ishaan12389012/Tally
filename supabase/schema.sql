-- Pocket Ledger database setup.
-- Paste this whole file into Supabase: SQL Editor > New query > Run.
-- Every row belongs to the signed-in user, and row level security makes sure
-- nobody can read or change anyone else's data.

create table if not exists public.transactions (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id         text not null,
  amount     numeric(14, 2) not null,
  type       text not null check (type in ('in', 'out')),
  category   text not null,
  note       text not null default '',
  date       date not null,
  created_ms bigint not null default 0,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists transactions_user_updated on public.transactions (user_id, updated_at);

create table if not exists public.settings (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  currency   text not null default 'USD',
  start_day  int  not null default 1 check (start_day between 1 and 28),
  budgets    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- updated_at is always set by the server, so devices can ask "what changed since X?"
-- clock_timestamp() (not now()) so rows written in one batch still sort after earlier batches.
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists transactions_touch on public.transactions;
create trigger transactions_touch before insert or update on public.transactions
  for each row execute function public.touch_updated_at();
drop trigger if exists settings_touch on public.settings;
create trigger settings_touch before insert or update on public.settings
  for each row execute function public.touch_updated_at();

alter table public.transactions enable row level security;
alter table public.settings enable row level security;

drop policy if exists "own transactions" on public.transactions;
create policy "own transactions" on public.transactions
  for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "own settings" on public.settings;
create policy "own settings" on public.settings
  for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Some newer Supabase projects don't give signed-in users access to new tables automatically.
-- Row level security above still limits each person to their own rows.
grant select, insert, update, delete on public.transactions to authenticated;
grant select, insert, update, delete on public.settings to authenticated;
