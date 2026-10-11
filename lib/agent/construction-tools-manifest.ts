import { FORECASTING_PRINCIPLES } from '@/lib/forecast/principles'
import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'
import { UPDATE_CONSTRUCTION_SCHEMA } from '@/lib/pending-actions/construction-schema'

export const CONSTRUCTION_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'portfolio_construction',
    description:
      'Return portfolio-construction actuals, assumptions, forecasts, and capital availability ' +
      "for one investment vehicle — a plan's Investments tab (its positions, planned deals and exits, with each " +
      'planned deal\'s key for update_portfolio_construction). Use it to answer how much capital remains, how reserves and ' +
      'new investments are planned, and what portfolio outcomes imply for fund returns. ' +
      '`timeline` is construction\'s own yearly schedule (the plan\'s net returns, as the page shows them, are forecast_returns): when `timelineNetOfCarry` ' +
      'is true it is the LP\'s net-of-carry schedule and `grossTimeline` holds the fund-level ' +
      'gross one. Say which measure a DPI, TVPI or IRR came from; do not quote one as the other. ' +
      "actuals.feePayingShare is the share of commitments charged fees; waterfall.lpCommitmentShare the LPs' share that bears carry. " +
      FORECASTING_PRINCIPLES,
    scope: 'read',
    // Fund-scoped dispatch, but the contents are governed by the accounting grant and switch.
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: { type: 'string', description: 'Investment vehicle name.' },
        planId: { type: 'string', description: "A plan's id (scenario or budget), from forecast_plans; omit for the entity's primary plan." },
      },
      required: ['vehicle'],
      additionalProperties: false,
    },
  },
  {
    name: 'portfolio_construction_update',
    description:
      "Change a plan's Investments tab — its portfolio construction — directly: add, change or remove planned deals one " +
      'at a time by key (check, timing, exit, simulation settings), set a held company\'s exit and follow-on, the fund-wide ' +
      'return assumptions (hold, default exit multiple, write-off rate, exit timing range), and the portfolio targets. ' +
      "Omit planId for the entity's primary plan. Saves immediately (the Analyst's update_portfolio_construction stages the " +
      'same change for approval instead). Fees and expenses are forecast_update_plan. ' + FORECASTING_PRINCIPLES,
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: UPDATE_CONSTRUCTION_SCHEMA as any,
  },
]
