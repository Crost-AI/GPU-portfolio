// Pure metadata for the OPERATIONS tools: the facts and status a quarter-end runs on. Where each
// entity's close stands, whether the portfolio companies have reported, which filings are owed,
// what went to the LPs, and the entity's own reporting profile. NO server imports (the Settings
// key UI lists these). Handlers live in operations-tools.ts.
//
// None of these is a checklist. They read state the app already keeps, so an assistant asked to
// plan or chase a quarter-end works from the fund's records rather than from what the question
// happened to say.
//
// Two lists, because two of the tools act on ONE entity's books and the dispatcher resolves (and
// access-checks) that entity for them: ENTITY_OPERATIONS are ledger tools, `vehicle` injected by
// the registry. The rest are fund-wide reads with an optional entity filter.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'
import { STRATEGIES } from '@/lib/vehicle-profile'

const QUARTER_END = {
  type: 'string',
  description: 'A quarter-end date (YYYY-MM-DD), e.g. 2026-09-30. Default: the latest quarter-end that has passed.',
}
const ENTITY_FILTER = { type: 'string', description: 'Optional: only this entity (fund or SPV), by name. Use list_vehicles to see them.' }

export const ENTITY_OPERATIONS_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'entity_profile',
    description:
      "An entity's reporting profile: its strategy (venture, buyout, …), who administers its books (an outside " +
      "administrator's name, or In-house), and how many days after a quarter-end its LP reporting is due (quarterly, " +
      'and annual for the December quarter). Use it before planning a quarter-end instead of asking the user for these. ' +
      'A field that is null has not been set: ask, then save it with set_entity_profile.',
    scope: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'set_entity_profile',
    description:
      "Set an entity's reporting profile. Send only the fields to change. The same fields as the Edit vehicle form in the app.",
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: [...STRATEGIES, ''], description: 'Empty string clears it.' },
        administrator: { type: 'string', description: 'The outside administrator\'s name, or "In-house". At most 200 characters; empty string clears it.' },
        lp_report_days_quarterly: { type: 'integer', description: 'Days after a quarter-end that quarterly LP reporting is due (1 to 365). Send null to clear it.' },
        lp_report_days_annual: { type: 'integer', description: 'Days after the December quarter-end that annual reporting is due (1 to 365). Send null to clear it.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'approve_close',
    description:
      'Sign off the prepared close review of every closed period through a date: the second half of prepare and ' +
      'approve. The person who prepared a close cannot approve it while another member can do the books. ' +
      'Read close_status first and check its open review items with the user.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['through'],
      properties: {
        through: { type: 'string', description: 'Approve every prepared review for periods ending on or before this date (YYYY-MM-DD).' },
        attestation: { type: 'string', description: 'What the approver reviewed, in their words. Default: the standard attestation.' },
      },
      additionalProperties: false,
    },
  },
]

export const OPERATIONS_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'close_status',
    description:
      'Where each entity stands for a quarter-end: whether the quarter is closed (closed, late, due, reopened, or none ' +
      'when the books do not reach it), whether the close review is prepared or approved and by whom, the review ' +
      'checks still open, and when LP reporting is due from the entity profile (with days remaining).',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      properties: { quarter_end: QUARTER_END, vehicle: ENTITY_FILTER },
      additionalProperties: false,
    },
  },
  {
    name: 'data_request_status',
    description:
      "A quarter's portfolio data request: whether it was sent, when responses are due, and which active companies " +
      'have reported (yes), not yet (no), are not applicable (na) or were given up on (waived). Reporting is detected ' +
      'from KPI values recorded for the quarter, overridden by what the team marked.',
    scope: 'read',
    domain: 'portfolio',
    accessFeature: 'asks',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer' },
        quarter: { type: 'integer', minimum: 1, maximum: 4 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'compliance_calendar',
    description:
      "The year's regulatory and reporting filings that apply to the fund (Form ADV, Form D, 13F, LP capital " +
      'statements, …), per entity, with their due dates and state: filed, open, overdue, or not_applicable for that ' +
      'occurrence. Items whose applicability nobody has decided yet are included and marked needs_review.',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'compliance',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: 'Default: this year.' },
        from: { type: 'string', description: 'Optional: only filings due on or after this date (YYYY-MM-DD).' },
        to: { type: 'string', description: 'Optional: only filings due on or before this date (YYYY-MM-DD).' },
        vehicle: ENTITY_FILTER,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'lp_delivery_log',
    description:
      'What was emailed to LPs: notices, statements, letters, reports and documents, with the recipient, the subject, ' +
      'when, and whether the send failed. Newest first, from a date (default: 90 days ago).',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'lp_relations',
    accessFeature: 'lp_portal',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'YYYY-MM-DD. Default: 90 days ago.' },
        kind: { type: 'string', enum: ['notice', 'receipt', 'statement', 'letter', 'snapshot', 'document', 'announcement', 'reply'] },
        limit: { type: 'integer', description: 'Default 100, max 500.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'whats_due',
    description:
      'Everything the fund has open with a date on it, earliest first: compliance filings due within 30 days or ' +
      "overdue, this quarter's data request to send or chase, capital calls past due, and LP onboarding waiting on the " +
      'team. The same list as the ops reminder email, cut to what this user may see.',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'compliance',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]
