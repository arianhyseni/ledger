-- ============================================================
--  tillroll — migration 002
--  Monthly debt / loan repayment stored per month alongside
--  income. Integer cents, same as every other amount.
-- ============================================================

alter table public.income
  add column if not exists debt integer not null default 0;
