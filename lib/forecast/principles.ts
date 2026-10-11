// How this app forecasts a fund, an SPV, a GP entity and a management company — stated once, and
// handed to every tool that drafts or explains a forecast, so the Analyst reasons the way the
// engine computes. Each line is something the engine does (cited), not advice.

export const FORECASTING_PRINCIPLES = [
  // One plan, one page (plans/plan-unified-plan.md §5).
  "A plan is one scenario of the whole entity, and each plan (rolling forecast, scenario or budget) has its own of everything. The Forecast page shows it as key figures (forecast_returns) above four tabs: Investments (the portfolio — positions, planned deals, exits; update_portfolio_construction), Capital planning (commitment use and reserves, calls and distributions, cash; update_forecast_plan capitalPolicy and cashFigures), Financials (fees, expenses, the P&L, hand entries; update_forecast_plan rules) and Returns (net returns by year and their simulated range). One plan per entity is primary: its figures are the headline ones. To try something without changing the plan, copy it as a scenario (create_forecast_plan seeded from the plan).",
  // Investments and exits (lib/forecast/adjustments.ts dealEditRefusal).
  'Investments and exits are entered on the Investments tab and nowhere else: a planned deal\'s check, timing (investInYears, exitInYears) and outcome, or a held company\'s exit (value or multiple, exitInYears) and follow-on — update_portfolio_construction, one deal at a time by key, on the plan named (planId) or the primary. Never as a cash figure, a rule or a hand entry. When a deal actually happens the user records it as a holding and removes or changes the planned deal; nothing matches them automatically, so if a holding looks like a planned deal, say so.',
  // Capital (lib/forecast/capital.ts).
  "Capital calls and distributions are worked out monthly from the plan's cash: calls keep cash at the policy's reserve (up to what is uncalled); exit proceeds are distributed after the policy's lag, keeping its distribution reserve. Any month can be set directly (cashFigures called/distributed); that overrides that month only — anything still owed is paid the following month. The waterfall runs on what is actually distributed, so a changed distribution moves the carry, the LPs' net and the GP entity's share. Carry is paid to whoever the fund's carry terms name (Allocation terms → Carry: usually its GP entity, but any partner or associate vehicle, in any split).",
  // Fees and expenses (lib/forecast/fee-rule.ts, plan-costs.ts).
  "Fees and expenses are the plan's own Financials rules: a fund's management fee is a management_fee rule (rate, basis, term, step-down, the GP's stake exempt); expenses are ordinary rules. Construction's capital planning reads them; they are never set on the Investments tab.",
  // GP entity (lib/forecast/linked.ts gpShareOf).
  "A GP entity's forecast comes from the fund it is GP of: its share of the fund primary plan's calls and distributions (its commitment over the fund's) and its percent of the carry that plan's waterfall pays. Do not add carry or distribution rules to a GP entity by hand.",
  // GP stake exemption (lib/accounting/construction.ts feePayingShare, construction-forecast.ts applyLpWaterfall).
  "The GP's own commitment pays no management fee and bears no carry. Fees are charged on the fee-paying commitments only; carry is the carry rate times the LPs' gain (their share of distributions beyond their capital), never on the GP's stake.",
  // Carry paid to date (lib/accounting/construction-service.ts carryInferred).
  'Carry already paid comes from the books (carry distributions). Where the books record none and there is no preferred return, it is worked out from the LPs\' distributions beyond their capital — rate ÷ (1 − rate) of that excess — so only carry still to come is forecast. portfolio_construction reports it as waterfall.carryPaidInferred; say so when you quote a carry total.',
  // Management company (linked_fee).
  "A management company has Financials and Capital planning only. Its fee revenue is a linked_fee rule: each linked fund's management fee from its primary plan, on that fee link's billing cycle.",
  // Prepaid (lib/forecast/compile.ts).
  'A cost paid before the plan and expensed monthly (a prepaid fee) uses cashTiming {mode:"prepaid"} — it draws down the prepaid balance with no cash in the plan. If the entity winds up before the prepaid fee is used (its last exit comes first), add refundMonth to that rule: the fee stops then and what is still prepaid is refunded and paid out to the investors. Never push cash outside the window with a large offset; offsets are limited to ±36 months.',
  // Exits (lib/forecast/plan.ts constructionEntries).
  'At an exit everything unrealized becomes realized: the company\'s mark (and currency translation) on the books is reversed against Change in unrealized appreciation, and the whole gain over cost is realized — so a forecast exit lowers unrealized appreciation and raises realized gain by the same mark.',
  // Hand edits (lib/forecast/adjustments.ts).
  'A P&L month is an override; a one-off is a hand entry (balanced, with replaces to change a generated fee, expense or opening-balance entry). Hand edits are kept through refreshes.',
  // Showing the effect.
  'To show what a change does, read forecast_returns before and after it — the same figures as the top of the page.',
  // Staleness and versions.
  'A draft recompiles from its sources when refreshed; a change to the portfolio, a linked fund or the actuals marks it out of date. As months close, a rolling forecast rolls forward on the actuals. Published versions (portfolio included) never change; a published budget or saved scenario is the comparison base (forecast_variance) as actuals come in.',
].join(' ')
