// Pure metadata for the DOCUMENT tools: the fund's preformatted reports, handed over as signed
// links (lib/agent/report-links.ts). NO server imports (the Settings key UI lists these).
// Handlers live in report-tools.ts; the documents themselves in lib/reports/documents.ts.
//
// Each tool's access is its web route's (lib/access/route-domains.ts), so the assistant can fetch
// exactly the documents the member could download from the app. The link is checked again when
// opened (app/api/agent/reports/[token]).

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

const VEHICLE = { type: 'string', description: 'The vehicle (portfolio_group), e.g. the fund or an SPV. Optional when the fund has one.' }
const LINK_NOTE =
  'The link works for an hour; give it to the user as a link. Call this again every time the document is asked for — ' +
  'never re-share a link from earlier in the conversation, which has likely expired.'

export const REPORT_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'fund_performance_pdf',
    description:
      'A download link to the fund performance report as a PDF, the same document the app produces: contributions, ' +
      'distributions and NAV over time, with DPI, RVPI, TVPI and IRR, as of a date. ' + LINK_NOTE,
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        as_of: { type: 'string', description: 'As-of date (YYYY-MM-DD). Default: the last quarter end.' },
        group_by: { type: 'string', enum: ['date', 'month', 'quarter'], description: 'How cash flows are grouped. Default month.' },
      },
    },
  },
  {
    name: 'financial_statements_pdf',
    description:
      'A download link to the financial statements as a PDF, the same package the app produces: balance sheet, ' +
      'operations, cash flows, changes in partners\' capital and the schedule of investments, for a period. ' + LINK_NOTE,
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        period: { type: 'string', enum: ['this_quarter', 'last_quarter', 'ytd', 'prior_year', 'itd'], description: 'The period. Default ytd. Or pass start and end.' },
        start: { type: 'string', description: 'Custom period start (YYYY-MM-DD).' },
        end: { type: 'string', description: 'Custom period end (YYYY-MM-DD).' },
        compare: { type: 'integer', minimum: 0, maximum: 4, description: 'Prior periods to show beside it as columns. Default 0.' },
        basis: { type: 'string', enum: ['book', 'tax'], description: 'Book (default) or tax basis.' },
      },
    },
  },
  {
    name: 'tax_package_zip',
    description:
      'A download link to the year\'s tax package as a ZIP, the same bundle the app produces for the preparer: ' +
      'workpapers with the prior year beside it, the statements PDF, the general ledger, the journal, the chart of ' +
      'accounts, and the final K-1 workbook when there is one and the member may see K-1s. ' + LINK_NOTE,
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        year: { type: 'integer', description: 'The tax year. Default: last year.' },
      },
    },
  },
  {
    name: 'schedule_k_pdf',
    description:
      'A download link to one partner\'s Schedule K-1 figures as a PDF, from the vehicle\'s K-1 package for a tax year ' +
      '(the latest version; it says whether that is final or a draft). K-1s include the carried-interest allocation, ' +
      'so this needs GP economics access. ' + LINK_NOTE,
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'tax',
    accessFeature: 'tax_reporting',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        lp: { type: 'string', description: 'LP entity id, or the investor/entity name.' },
        tax_year: { type: 'integer', description: 'The tax year. Default: last year.' },
      },
      required: ['lp'],
    },
  },
  {
    name: 'lp_snapshot_pdf',
    description:
      'A download link to the investor report an LP sees in the portal for a stored snapshot, as a PDF: their positions ' +
      'across every vehicle as the administrator reported them. Needs access to every entity, because the report shows ' +
      'everything the investor holds. ' + LINK_NOTE,
    scope: 'read',
    domain: 'lp',
    accessFeature: 'lp_portal',
    inputSchema: {
      type: 'object',
      properties: {
        investor: { type: 'string', description: 'The investor (or one of their entities), by name or id.' },
        snapshot: { type: 'string', description: 'Snapshot id or name. Omit for the most recent.' },
      },
      required: ['investor'],
    },
  },
]
