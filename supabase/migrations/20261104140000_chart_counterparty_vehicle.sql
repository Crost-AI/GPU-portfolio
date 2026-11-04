-- Which vehicle an intercompany account is with (lib/accounting/intercompany.ts,
-- pickIntercompanyAccounts). Until now the only link was the account CODE: the app looks for
-- `1900-<first 8 of the counterparty's id>` ("Due from <fund>") and `2900-<…>` ("Due to <fund>").
-- A chart imported from QuickBooks names the same account "Due from Fund III" under a plain code,
-- so the partnership-expense invoice could not find it and offered to create a second one.
--
-- With the column set, the account is found by the link whatever its code or name, and the code
-- convention is only the fallback for an account nobody has linked.
--
-- ADDITIVE AND SAFE BEFORE DEPLOY. A nullable column the live release neither reads nor writes.

alter table public.chart_of_accounts
  add column if not exists counterparty_vehicle_id uuid references fund_vehicles(id) on delete set null;

-- One "Due from" and one "Due to" per counterparty on a vehicle's books: two receivables linked to
-- the same fund would split its balance, and the invoice could bill only one of them.
create unique index if not exists chart_of_accounts_counterparty_uniq
  on public.chart_of_accounts (fund_id, vehicle_id, counterparty_vehicle_id, type)
  where counterparty_vehicle_id is not null;

-- Link the accounts the app already made, from the id prefix in their code. A prefix that matches
-- two vehicles of the fund (vanishingly rare) is left unlinked rather than guessed.
update public.chart_of_accounts c
   set counterparty_vehicle_id = v.id
  from public.fund_vehicles v
 where c.counterparty_vehicle_id is null
   and c.vehicle_id is not null
   and v.fund_id = c.fund_id
   and v.id <> c.vehicle_id
   and c.code ~ '^(1900|2900)-[0-9a-f]{8}$'
   and left(v.id::text, 8) = split_part(c.code, '-', 2)
   and (select count(*) from public.fund_vehicles v2
         where v2.fund_id = c.fund_id and left(v2.id::text, 8) = split_part(c.code, '-', 2)) = 1;
