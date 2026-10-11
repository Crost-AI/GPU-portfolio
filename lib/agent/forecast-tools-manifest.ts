import { FORECASTING_PRINCIPLES } from '@/lib/forecast/principles'
import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'
import { CREATE_PLAN_SCHEMA, PUBLISH_PLAN_SCHEMA, UPDATE_PLAN_SCHEMA } from '@/lib/forecast/actions'

// Forecast, read side. Same service as the page and the API (lib/forecast/service.ts),
// so a number quoted by the Analyst is the number on the screen. Gated on accounting (Forecast has
// no switch of its own); a management company also needs its own grant, checked by the service.

const VEHICLE = { type: 'string', description: 'Vehicle name — a fund, SPV or management company.' }

export const FORECAST_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'forecast_list_plans',
    description:
      'List the plans for one vehicle — rolling forecasts (scenarios) and budgets — with their published versions ' +
      '(an "approved" version is the budget baseline), which one is primary (isPrimary: the one headline figures read), ' +
      'each plan\'s calls/distributions policy and month edits (capital), and the month the books are closed through. ' +
      'Each plan has its own portfolio (Investments tab) and its own fees and expenses (Financials tab). Call this first to find a plan id.',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      properties: { vehicle: VEHICLE },
      required: ['vehicle'],
      additionalProperties: false,
    },
  },
  {
    name: 'forecast_series',
    description:
      'Monthly, quarterly or annual P&L (revenue, expenses, net income, by account) and cash ' +
      '(opening, movement, ending) for a date range. view "actual" = posted actuals only; "plan" = ' +
      'the plan alone; "combined" (default with a plan) = actuals through the cutoff, then the plan. ' +
      'Every period carries a status — actual, actual_unclosed, forecast or mixed — and the result ' +
      'gives actualsThrough, closedThrough, version and warnings: always say which periods are ' +
      'projected, which months are unclosed, and which plan/version the projection is. Quarterly and ' +
      'annual cash is the opening of the first month and the ending of the last, never a sum.',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        planId: { type: 'string', description: 'Plan id from forecast_list_plans. Omit for actuals only.' },
        versionId: { type: 'string', description: 'A published version, to see it as originally published. Omit for the current draft.' },
        view: { type: 'string', enum: ['actual', 'plan', 'combined'] },
        start: { type: 'string', description: 'First month, YYYY-MM.' },
        end: { type: 'string', description: 'Last month, YYYY-MM (at most 240 months after start).' },
        interval: { type: 'string', enum: ['month', 'quarter', 'year'] },
      },
      required: ['vehicle', 'start', 'end'],
      additionalProperties: false,
    },
  },
  {
    name: 'forecast_explain',
    description:
      'Explain one plan: each account\'s rule (method, parameters, cash timing) with the basis it ' +
      'computes from and its warnings, every month override, the actuals cutoff and whether the draft ' +
      'is stale against the books, and its versions. Use it to answer where a forecast number comes ' +
      'from, what is manually overridden, and what rests on unclosed or missing actuals. `editableEntries` lists the ' +
      'construction, opening-balance and hand entries with their keys — pass a key to update_forecast_plan as ' +
      '`replaces` (to change it) or in `removeEntries`.',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      properties: { vehicle: VEHICLE, planId: { type: 'string' } },
      required: ['vehicle', 'planId'],
      additionalProperties: false,
    },
  },
  {
    name: 'forecast_variance',
    description:
      'Variance of actuals (or another plan) against a plan, by account and period: base, compare, ' +
      'dollar difference, percentage (null when the base is 0) and whether it is favourable — revenue ' +
      'above or expense below the base. Default base is the plan\'s approved version; pass ' +
      'baseVersionId "draft" or a version id to use another. compare "actual" (default) only counts ' +
      'months that have actuals, and periods with fewer marked partial; pass comparePlanId for the ' +
      'latest forecast against a budget. `largest` lists the biggest misses by dollars. Quarterly and ' +
      'annual percentages come from summed dollars, never averaged.',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        planId: { type: 'string', description: 'The base plan.' },
        baseVersionId: { type: 'string', description: "'approved' (default), 'draft', or a version id." },
        comparePlanId: { type: 'string', description: 'Compare another plan instead of actuals.' },
        compareVersionId: { type: 'string', description: "'draft' (default) or a version id of the compare plan." },
        start: { type: 'string', description: 'First month, YYYY-MM.' },
        end: { type: 'string', description: 'Last month, YYYY-MM.' },
        interval: { type: 'string', enum: ['month', 'quarter', 'year'] },
      },
      required: ['vehicle', 'planId', 'start', 'end'],
      additionalProperties: false,
    },
  },
  {
    name: 'forecast_returns',
    description:
      "A plan's returns — the figures at the top of the Forecast page and its Returns tab, from one calculation over the plan: " +
      'gross MOIC (the portfolio), LP TVPI, DPI and IRR (net of fees, expenses and carry, what is left valued through the waterfall), ' +
      'calls, distributions and carry by calendar year, the year half the distributions are back, month-end cash and its lowest point ' +
      'against the call reserve. simulate:true adds ranges (p10/p50/p90) across simulated exits — value and timing — each rerun through ' +
      'the plan\'s calls, distributions and waterfall. Use it to show the effect of a change: read it before and after. Omit planId for ' +
      'the primary plan. ' + FORECASTING_PRINCIPLES,
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        planId: { type: 'string', description: 'Plan id from forecast_list_plans; omit for the primary plan.' },
        simulate: { type: 'boolean', description: 'Add simulated ranges (slower).' },
      },
      required: ['vehicle'],
      additionalProperties: false,
    },
  },
  {
    name: 'forecast_create_plan',
    description:
      'Create a budget (a fiscal year, monthly) or a rolling forecast (starts after the last closed month, ' +
      '12/18/24/36-month horizon) for one vehicle, seeded blank, from actuals, or from another plan. Seeding from a plan ' +
      'copies it whole as a new scenario — its portfolio, fee and expense rules, calls/distributions policy and month edits, and hand ' +
      'edits. Never posts to the ledger.',
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: CREATE_PLAN_SCHEMA as any,
  },
  {
    name: 'forecast_update_plan',
    description:
      'Change a plan\'s Financials and Capital planning: set or remove account rules (fees, expenses), set or clear month ' +
      'overrides, a month\'s capital call or distribution (cashFigures) or the calls/distributions policy (capitalPolicy), hand ' +
      'entries, or its cutoff/horizon/name/primary. Accounts are given by code. Investments and exits are not here — use ' +
      'update_portfolio_construction. The draft recompiles; published versions never change. Pass expectedRevision from ' +
      'forecast_explain to refuse a stale write.',
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: UPDATE_PLAN_SCHEMA as any,
  },
  {
    name: 'forecast_publish',
    description:
      'Save a plan as it stands — investments, financials and capital — as a scenario (status "published") or as ' +
      'its budget (status "approved", one per plan), the base actuals are compared against. A saved scenario never changes.',
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: PUBLISH_PLAN_SCHEMA as any,
  },
  {
    name: 'forecast_fee_links',
    description:
      'List which funds pay which management company and on what billing cycle (fee links), for one ' +
      'vehicle. A linked-fee rule forecasts nothing without one. A fund you cannot see appears with its ' +
      'name withheld.',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: { type: 'object', properties: { vehicle: VEHICLE }, required: ['vehicle'], additionalProperties: false },
  },
  {
    name: 'forecast_set_fee_link',
    description:
      'Create or change an entity link: the fund pays the management company its management fee, billed every ' +
      'everyMonths (1/3/6/12) starting in anchorMonth, in advance or arrears, cash cashLagMonths later. ' +
      'Needs write on both vehicles. vehicle is the management company.',
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      required: ['vehicle', 'fund'],
      additionalProperties: false,
      properties: {
        vehicle: { type: 'string', description: 'The management company.' },
        fund: { type: 'string', description: 'The fund that pays it.' },
        everyMonths: { type: 'number', enum: [1, 3, 6, 12] },
        anchorMonth: { type: 'number' },
        direction: { type: 'string', enum: ['advance', 'arrears'] },
        cashLagMonths: { type: 'number' },
        active: { type: 'boolean' },
      },
    },
  },
  {
    name: 'forecast_suggest_rules',
    description:
      'Suggest a forecasting rule for every income and expense account of a vehicle from its own closed ' +
      'history — at least 12 months, up to 36 — so annual and quarterly bills, seasonal shapes (a December ' +
      'bonus), trends and step changes are recognised rather than averaged away. Each suggestion has its ' +
      'method and parameters, a confidence and the evidence. Linked sources win where they exist (fee ' +
      'links, construction). Creates nothing: pass the suggestions, adjusted for what the user said, to ' +
      'create_forecast_plan. ' + FORECASTING_PRINCIPLES,
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      properties: { vehicle: VEHICLE, lookbackMonths: { type: 'number', description: '12–36, default 36.' } },
      required: ['vehicle'],
      additionalProperties: false,
    },
  },
]
