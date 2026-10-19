// Pure metadata for the HOLDING agent tools: a holding's name and kind, moving a transaction to the
// right holding, and a fund holding's register (terms, capital notices, NAV statements). NO server
// imports. Handlers live in holding-tools.ts; merging two holdings is a destructive tool
// (destructive-tools-manifest.ts merge_companies).
//
// Fund-scoped like the portfolio tools: `vehicle` names the entity a register row belongs to and is
// resolved in the handler, never injected.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

const COMPANY = { type: 'string', description: 'Company id, or the company name (matched case-insensitively).' }
const HOLDING = { type: 'string', description: 'The fund holding\'s id or name.' }
const VEHICLE = {
  type: 'string',
  description: 'The entity that holds the fund (its name). Optional when the holding\'s register or ledger already names exactly one.',
}
const DATE = { type: 'string', description: 'YYYY-MM-DD' }

export const HOLDING_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'update_company',
    description:
      'Rename a holding (company, fund holding or digital asset), set or add its aliases, or set its status. A rename also renames ' +
      'the holding\'s own chart accounts that still carry the old name ("Investment — <name>" and the rest). Aliases are the other ' +
      'names imports and emailed updates match it by; add_aliases adds to the ones already there, aliases replaces them.',
    scope: 'write',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      required: ['company'],
      properties: {
        company: COMPANY,
        name: { type: 'string', description: 'The new name.' },
        aliases: { type: 'array', items: { type: 'string' }, description: 'Replace every alias with these.' },
        add_aliases: { type: 'array', items: { type: 'string' }, description: 'Add these aliases, keeping the existing ones.' },
        status: { type: 'string', enum: ['active', 'exited', 'written-off'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_holding_type',
    description:
      'Change what kind of holding a record is: company or fund (a fund the entity invests in as an LP, with a register of terms, ' +
      'capital notices and NAV statements). Its transactions and ledger accounts are unchanged. A fund holding with notices or NAV ' +
      'statements cannot become a company until those are changed and the register cleared (clear_fund_register). Digital assets ' +
      'are changed on the company page.',
    scope: 'write',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      required: ['company', 'holding_type'],
      properties: {
        company: COMPANY,
        holding_type: { type: 'string', enum: ['company', 'fund'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'move_investment',
    description:
      'Move a recorded portfolio transaction to another holding: a payment booked against the wrong company or fund. Its journal ' +
      'entry is retracted and re-derived on the other holding\'s accounts, so cash and every other account stay as they were. ' +
      'Refused for a transaction in a closed period, one the fund register owns (move the notice instead), and either end of a ' +
      'SAFE/note conversion. To combine two records of the same holding, use merge_companies.',
    scope: 'write',
    domain: 'portfolio',
    accessFeature: 'investments',
    inputSchema: {
      type: 'object',
      required: ['company', 'transaction_id', 'to_company'],
      properties: {
        company: { type: 'string', description: 'The holding the transaction is on now (id or name).' },
        transaction_id: { type: 'string', description: 'The transaction id, from list_investments.' },
        to_company: { type: 'string', description: 'The holding it belongs to (id or name).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_fund_terms',
    description:
      'Set a fund holding\'s terms on one entity: the commitment (which unfunded is derived from), and optionally the commitment ' +
      'date, manager, vintage, fund size, strategy, geography, final close and term end. Creates the terms when there are none. ' +
      'Only the fields passed change.',
    scope: 'write',
    domain: 'portfolio',
    accessFeature: 'investments',
    inputSchema: {
      type: 'object',
      required: ['company'],
      properties: {
        company: HOLDING,
        vehicle: VEHICLE,
        commitment: { type: 'number', description: 'The entity\'s commitment to the fund.' },
        commitment_date: DATE,
        manager_name: { type: 'string' },
        vintage_year: { type: 'integer' },
        fund_size: { type: 'number' },
        strategy: { type: 'string' },
        geography: { type: 'string' },
        final_close_date: DATE,
        term_end_date: DATE,
        notes: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'record_fund_notice',
    description:
      'Record a capital call or distribution notice a fund holding sent this entity. Pass transaction_id to LINK it to the ' +
      'investment (call) or proceeds (distribution) transaction already on the books for that payment: nothing is booked again, and ' +
      'the transaction must be this holding\'s, on this entity, for the same amount. Without transaction_id the notice is BOOKED: its ' +
      'transaction and journal entry are made, as Confirm on the holding page does. A call\'s purposes (investments, fees, expenses) ' +
      'and a distribution\'s character (return of capital, realized gain, income) must add up to the amount; a call defaults to all ' +
      'investments, a linked distribution to the transaction\'s own cost basis exited and gain. Once recorded, the transaction is ' +
      'changed from the notice, not the company page.',
    scope: 'write',
    domain: 'portfolio',
    accessFeature: 'investments',
    inputSchema: {
      type: 'object',
      required: ['company', 'kind', 'event_date', 'amount'],
      properties: {
        company: HOLDING,
        vehicle: VEHICLE,
        kind: { type: 'string', enum: ['call', 'distribution'] },
        event_date: { type: 'string', description: 'The notice\'s date (YYYY-MM-DD); for a linked notice, usually the payment\'s date.' },
        amount: { type: 'number', description: 'The notice amount, positive for both kinds.' },
        transaction_id: { type: 'string', description: 'The transaction already on the books for this payment (list_investments).' },
        due_date: DATE,
        notice_number: { type: 'string' },
        description: { type: 'string' },
        purpose_investments: { type: 'number' },
        purpose_fees: { type: 'number' },
        purpose_expenses: { type: 'number' },
        char_return_of_capital: { type: 'number' },
        char_realized_gain: { type: 'number' },
        char_income: { type: 'number' },
        recallable_amount: { type: 'number', description: 'The part of a distribution the fund may call again.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'record_nav_statement',
    description:
      'Record a manager NAV statement for a fund holding: its NAV as of a date, as the holding page\'s Manager NAV statements do. ' +
      'Saving books a mark for the difference between the NAV and what the ledger carries on that date (none when they already ' +
      'agree), and a statement for the same holding, entity and date replaces the earlier one. The result says what was booked.',
    scope: 'write',
    domain: 'portfolio',
    accessFeature: 'investments',
    inputSchema: {
      type: 'object',
      required: ['company', 'as_of_date', 'reported_nav'],
      properties: {
        company: HOLDING,
        vehicle: VEHICLE,
        as_of_date: { type: 'string', description: 'The manager\'s valuation date (YYYY-MM-DD), not when it arrived.' },
        reported_nav: { type: 'number', description: 'This entity\'s NAV in the fund on that date.' },
        basis: { type: 'string', enum: ['final', 'preliminary', 'estimate'] },
        received_date: DATE,
        reported_contributions: { type: 'number', description: 'The manager\'s since-inception contributions, for tying out.' },
        reported_distributions: { type: 'number', description: 'The manager\'s since-inception distributions, for tying out.' },
        reported_unfunded: { type: 'number', description: 'The manager\'s unfunded commitment, for tying out.' },
      },
      additionalProperties: false,
    },
  },
]
