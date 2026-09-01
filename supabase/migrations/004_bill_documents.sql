-- A bill document stays in IndexedDB on the device that attached it. Only this
-- availability flag syncs so another device can explain why it cannot open it.
alter table public.bills
  add column if not exists has_document boolean not null default false;
