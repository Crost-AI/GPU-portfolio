import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'
import { VEHICLE_KINDS } from '@/lib/vehicle-kinds'

// Setting a fund up without the web app: where setup stands, and one call that applies a plan
// (lib/onboarding/setup-plan.ts). Admins only: both are gated on the `admin` domain, which no
// grant confers. Fund-scoped (`domain: 'portfolio'` is the dispatch grouping, not the gate).

const ENTITY = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'e.g. "Fund I", "Acme SPV", "Hemrock Management".' },
    kind: { type: 'string', enum: [...VEHICLE_KINDS], description: 'Default fund. manco needs the management_company product.' },
    vintageYear: { type: 'integer' },
  },
  required: ['name'],
  additionalProperties: false,
}

const TEAM_MEMBER = {
  type: 'object',
  properties: {
    email: { type: 'string' },
    role: { type: 'string', enum: ['admin', 'member'], description: 'Default member. Admins approve deletes, capital calls, distributions, LP publishing and K-1 finalization.' },
    preset: {
      type: 'string',
      enum: ['cfo', 'fund_admin', 'tax', 'auditor', 'investment_team', 'investor_relations'],
      description: 'Members only. Sets their access to every area in one step.',
    },
    accessEndsOn: { type: 'string', description: 'YYYY-MM-DD. Members only, e.g. an auditor or tax preparer for one engagement.' },
    entities: {
      description: '"all" (default) or a list of entity names they may see.',
      oneOf: [{ type: 'string', enum: ['all'] }, { type: 'array', items: { type: 'string' } }],
    },
  },
  required: ['email'],
  additionalProperties: false,
}

export const SETUP_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'setup_status',
    description:
      'Where this fund\'s setup stands, for an admin: the products that are on, its entities, the team and their access, ' +
      'and the getting-started checklist with each step\'s status. Each open step says which tool does it from chat ' +
      '(often setup_fund, add_partner, record_investment, post_ledger_text or close_period) or links the web page where it lives. ' +
      'Call this first when someone asks to set up the fund, and again after each change.',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'admin',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'setup_fund',
    description:
      'Set the fund up from a plan, in one call: its name, the products it runs, its entities (each gets a chart of accounts), ' +
      'its team with their access, and the email addresses allowed to send company updates. Safe to re-run: entities match by name, ' +
      'people and senders by email. Adding someone who has no account sends them an invitation email. ' +
      'Products: portfolio_reporting, fund_operations (books, carry, tax, compliance), lp_reporting (LP capital and portal), ' +
      'investment_workflow (deals and diligence), management_company. While the fund is new this is the full choice; once it is ' +
      'set up, products are only added, never switched off. Presets: cfo, fund_admin, tax, auditor, investment_team, investor_relations. ' +
      'Confirm the plan with the person before calling. Do not ask for or pass API keys or passwords here.',
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'admin',
    inputSchema: {
      type: 'object',
      properties: {
        fundName: { type: 'string' },
        products: {
          type: 'array',
          items: { type: 'string', enum: ['portfolio_reporting', 'fund_operations', 'lp_reporting', 'investment_workflow', 'management_company'] },
        },
        entities: { type: 'array', items: ENTITY },
        team: { type: 'array', items: TEAM_MEMBER },
        authorizedSenders: {
          type: 'array',
          description: 'People or addresses allowed to email company updates in.',
          items: { type: 'object', properties: { email: { type: 'string' }, label: { type: 'string' } }, required: ['email'], additionalProperties: false },
        },
        finish: { type: 'boolean', description: 'Mark setup as finished, so the web app stops showing the setup wizard.' },
      },
      additionalProperties: false,
    },
  },
]
