-- ============================================================
--  TillRoll — Bills v1
--  Recurring bill templates and individual due/paid bills.
--  Original bill documents remain device-only in this version.
-- ============================================================

create table public.bill_accounts (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  utility_type text not null default 'other',
  account_reference text,
  category_id uuid,
  recurrence text not null default 'once'
    check (recurrence in ('once', 'monthly', 'quarterly', 'yearly')),
  default_amount integer not null default 0 check (default_amount >= 0),
  due_day integer check (due_day between 1 and 31),
  next_due_date date,
  note text,
  active boolean not null default true,
  deleted boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.bills (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.bill_accounts(id) on delete cascade,
  due_date date not null,
  month text not null,
  amount integer not null default 0 check (amount >= 0),
  usage numeric,
  usage_unit text,
  status text not null default 'due' check (status in ('due', 'paid')),
  paid_date date,
  expense_id uuid,
  note text,
  has_document boolean not null default false,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (user_id, account_id, due_date)
);

create index bill_accounts_user_updated_idx
  on public.bill_accounts (user_id, updated_at);
create index bills_user_updated_idx
  on public.bills (user_id, updated_at);
create index bills_user_month_idx
  on public.bills (user_id, month);

create or replace function public.tillroll_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger bill_accounts_touch_updated_at
before update on public.bill_accounts
for each row execute function public.tillroll_touch_updated_at();

create trigger bills_touch_updated_at
before update on public.bills
for each row execute function public.tillroll_touch_updated_at();

alter table public.bill_accounts enable row level security;
alter table public.bills enable row level security;

create policy "Users manage their bill accounts"
on public.bill_accounts for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users manage their bills"
on public.bills for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

grant select, insert, update, delete on public.bill_accounts to authenticated;
grant select, insert, update, delete on public.bills to authenticated;
