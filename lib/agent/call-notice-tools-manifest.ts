// Pure metadata for the CAPITAL CALL NOTICE tools. NO server imports (the Settings key UI lists
// these). Handlers live in call-notice-tools.ts and call lib/accounting/call-notice-drafts.ts, the
// same service the call-notices route calls.
//
// These answer the prompt "draft a capital call notice for [fund]: total call, purpose with
// amounts, due date, the LPA notice period; calculate each LP's share; do not invent dates, wire
// details or fee terms; list what is missing; flag any date inside the notice period". The app
// does the arithmetic and the checks from its own records; the assistant presents them. It never
// fills a gap the result lists as missing.
//
// LP capital, like the Capital page. A draft is invisible to LPs; approving one is admin-only and,
// from chat, waits for an admin to approve it in the app.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

const base = { domain: 'ledger' as const, accessDomain: 'lp_capital' as const }
const VEHICLE = { type: 'string', description: 'The fund or SPV (portfolio_group) the call is on. Use list_vehicles to see them.' }
const DRAFT = { type: 'string', description: 'The draft id, from draft_capital_call_notice or capital_call_notice_drafts.' }

const PURPOSES = {
  type: 'array',
  description:
    'What the call is for, with amounts that add up to the total. Use the user\'s own figures; never split a total into ' +
    'purposes yourself.',
  items: {
    type: 'object',
    required: ['category', 'amount'],
    properties: {
      category: { type: 'string', enum: ['investment', 'management_fee', 'fund_expense', 'other'] },
      amount: { type: 'number' },
      description: { type: 'string', description: 'E.g. "Series A in Acme", "Q1 2027 management fee", "audit and tax".' },
      basis: { type: 'string', description: 'Fees only: the basis exactly as the user stated it ("2% of commitments, Q1 2027"). Omit if they did not.' },
      date: { type: 'string', description: 'YYYY-MM-DD a purpose depends on, e.g. the closing it funds. Only if the user gave it.' },
    },
  },
}

const REQUEST_FIELDS = {
  total: { type: 'number', description: 'The total call across all LPs.' },
  purposes: PURPOSES,
  notice_date: { type: 'string', description: 'YYYY-MM-DD the notice is sent. Only if the user gave it; never assume today.' },
  due_date: { type: 'string', description: 'YYYY-MM-DD the capital is due. Only if the user gave it.' },
  notice_period_days: { type: 'integer', description: 'The LPA notice period the user stated, in days. The vehicle\'s recorded LPA term is checked as well.' },
  notice_period_basis: { type: 'string', enum: ['calendar', 'business'], description: 'Whether the period is calendar or business days, if the user said.' },
  description: { type: 'string', description: 'A line for the notice body. Built from the purposes when omitted.' },
}

const RESULT =
  'Returns each LP\'s share (from stored commitments), the earliest due date the notice period allows, `missing` (what ' +
  'neither the user nor the records supplied) and `flags` (blockers and warnings, including any date inside the notice ' +
  'period). Present the per-LP table, then list every missing item and every flag. Do not fill a missing item yourself.'

export const CALL_NOTICE_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'draft_capital_call_notice',
    description:
      'Draft a capital call notice from the user\'s request. Saves a DRAFT only: nothing is posted and no LP sees it until an ' +
      'admin approves it. ' + RESULT,
    scope: 'write',
    ...base,
    inputSchema: { type: 'object', required: ['total'], properties: { vehicle: VEHICLE, ...REQUEST_FIELDS } },
  },
  {
    name: 'revise_capital_call_notice',
    description: 'Change an open capital call notice draft (dates, purposes, total, notice period). Only the fields given change; the checks run again. ' + RESULT,
    scope: 'write',
    ...base,
    inputSchema: { type: 'object', required: ['draft_id'], properties: { vehicle: VEHICLE, draft_id: DRAFT, ...REQUEST_FIELDS } },
  },
  {
    name: 'capital_call_notice_drafts',
    description: 'The capital call notice drafts on a vehicle, newest first: status (draft, approved, discarded), total, dates.',
    scope: 'read',
    ...base,
    inputSchema: { type: 'object', properties: { vehicle: VEHICLE, status: { type: 'string', enum: ['draft', 'approved', 'discarded'] } } },
  },
  {
    name: 'capital_call_notice_draft',
    description: 'One capital call notice draft, re-checked against today\'s records. ' + RESULT,
    scope: 'read',
    ...base,
    inputSchema: { type: 'object', required: ['draft_id'], properties: { vehicle: VEHICLE, draft_id: DRAFT } },
  },
  {
    name: 'capital_call_notice_pdf',
    description:
      'A link to one LP\'s notice as the draft stands, marked DRAFT. The link works for an hour and only for the user; give ' +
      'it as a link.',
    scope: 'read',
    ...base,
    inputSchema: {
      type: 'object', required: ['draft_id', 'lp'],
      properties: { vehicle: VEHICLE, draft_id: DRAFT, lp: { type: 'string', description: 'LP entity id or name, from the draft\'s lines.' } },
    },
  },
  {
    name: 'discard_capital_call_notice',
    description: 'Discard an open capital call notice draft. Nothing was issued, so nothing else changes.',
    scope: 'write',
    ...base,
    inputSchema: { type: 'object', required: ['draft_id'], properties: { vehicle: VEHICLE, draft_id: DRAFT } },
  },
  {
    name: 'approve_capital_call_notice',
    description:
      'Approve a capital call notice draft: issues the call to the books. Admin only; from chat it waits for an admin to ' +
      'approve it in the app. The LPs\' notices are then published from the app. Refused while anything required is ' +
      'missing or a blocker stands; set acknowledge only after the user has read and accepted every warning.',
    scope: 'write',
    ...base,
    inputSchema: {
      type: 'object', required: ['draft_id'],
      properties: { vehicle: VEHICLE, draft_id: DRAFT, acknowledge: { type: 'boolean', description: 'The user accepted every warning and optional missing item.' } },
    },
  },
  {
    name: 'set_call_notice_period',
    description:
      'Record the LPA\'s capital call notice period on a vehicle, so every drafted notice is checked against it. Admin only. ' +
      'Use the figure from the LPA as the user states it.',
    scope: 'write',
    ...base,
    inputSchema: {
      type: 'object', required: ['days'],
      properties: {
        vehicle: VEHICLE,
        days: { type: 'integer', description: 'Notice period in days, 0 to 365.' },
        basis: { type: 'string', enum: ['calendar', 'business'], description: 'Calendar days (default) or business days.' },
      },
    },
  },
]
