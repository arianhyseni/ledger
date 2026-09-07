-- ============================================================
--  TillRoll — Recurring expenses + category groups
--  Recurring expenses are plain categorized monthly spending
--  with no due date or payment tracking (distinct from
--  bill_accounts/bills, which track provider due-dates and OCR).
--  Category groups back the 50/30/20 needs/wants split shown
--  on Home and Insights.
-- ============================================================

alter table public.categories
  add column if not exists "group" text not null default 'variable'
    check ("group" in ('fixed', 'variable', 'wants'));

create table public.recurring_expenses (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  category_id uuid,
  amount integer not null default 0 check (amount >= 0),
  start_month text not null,
  duration_mode text not null default 'open'
    check (duration_mode in ('open', 'months', 'until')),
  duration_months integer,
  until_month text,
  active boolean not null default true,
  stopped_from_month text,
  note text,
  deleted boolean not null default false,
  updated_at timestamptz not null default now()
);

create index recurring_expenses_user_updated_idx
  on public.recurring_expenses (user_id, updated_at);
create index recurring_expenses_user_active_idx
  on public.recurring_expenses (user_id, active);

-- Reuses the trigger function already created in 003_bills.sql.
create trigger recurring_expenses_touch_updated_at
before update on public.recurring_expenses
for each row execute function public.tillroll_touch_updated_at();

alter table public.recurring_expenses enable row level security;

create policy "Users manage their recurring expenses"
on public.recurring_expenses for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

grant select, insert, update, delete on public.recurring_expenses to authenticated;

-- A generated expense points back at the recurring expense that made
-- it, the same way bills.expense_id points forward at a paid bill's
-- expense — just in the other direction. Null for hand-entered rows.
alter table public.expenses
  add column if not exists recurring_expense_id uuid;

create index if not exists expenses_recurring_expense_idx
  on public.expenses (recurring_expense_id);
