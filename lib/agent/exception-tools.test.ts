import { describe, expect, it } from 'vitest'
import { accessDomainFor, getTool, isLedgerTool } from '@/lib/accounting/agent-tools'
import { shouldStage } from './dispatch'
import { settlementReviewProblem } from '@/lib/accounting/settlement-reviews'

// The tools that finish what automation starts: the review queue, bank matching, settlements and
// the K-1 chase list. Each wraps the page's own function; these pin who may call it and that a
// connected chat's write still waits for a person.

const UUID_A = '00000000-0000-0000-0000-000000000001'
const UUID_B = '00000000-0000-0000-0000-000000000002'
const chat = { keyId: 'oauth:abc' }

describe('exception-handling tools', () => {
  it('gate on the area each one changes', () => {
    const expected: Record<string, string> = {
      review_queue: 'portfolio',
      resolve_review: 'portfolio',
      book_capital_call: 'lp_capital',
      book_distribution_from_bank: 'lp_capital',
      auto_match_bank_capital: 'lp_capital',
      bank_call_candidates: 'lp_capital',
      link_bank_transaction: 'accounting',
      restore_bank_transaction: 'accounting',
      capital_settlements: 'lp_capital',
      review_capital_settlement: 'lp_capital',
      holding_k_ones: 'tax',
      mark_holding_k_one: 'tax',
      tax_adjustments: 'tax',
      post_tax_adjustments: 'tax',
    }
    for (const [name, domain] of Object.entries(expected)) {
      const tool = getTool(name)
      expect(tool, name).toBeDefined()
      expect(accessDomainFor(tool!), name).toBe(domain)
    }
    expect(getTool('holding_k_ones')!.accessFeature).toBe('tax_reporting')
    expect(getTool('mark_holding_k_one')!.accessFeature).toBe('tax_reporting')
    expect(getTool('post_tax_adjustments')!.accessFeature).toBe('tax_reporting')
  })

  it('work on one set of books, except the review queue', () => {
    expect(isLedgerTool(getTool('review_queue')!)).toBe(false)
    expect(isLedgerTool(getTool('resolve_review')!)).toBe(false)
    for (const name of ['link_bank_transaction', 'auto_match_bank_capital', 'review_capital_settlement', 'mark_holding_k_one']) {
      expect(isLedgerTool(getTool(name)!), name).toBe(true)
    }
  })

  it('stage every write from a connected chat for a person to approve', () => {
    for (const name of ['resolve_review', 'book_capital_call', 'book_distribution_from_bank',
      'link_bank_transaction', 'restore_bank_transaction', 'review_capital_settlement', 'mark_holding_k_one', 'post_tax_adjustments']) {
      const tool = getTool(name)!
      expect(tool.scope, name).toBe('write')
      expect(tool.destructive, name).toBeUndefined()
      expect(shouldStage(tool, {}, chat), name).toBe(true)
    }
    // Auto-match writes drafts on drafted rows only, like categorizing: it runs, and posting stages.
    expect(shouldStage(getTool('auto_match_bank_capital')!, {}, chat)).toBe(false)
    for (const name of ['review_queue', 'bank_call_candidates', 'capital_settlements', 'holding_k_ones', 'tax_adjustments']) {
      expect(getTool(name)!.scope, name).toBe('read')
    }
  })

  it('name the partner on a capital-call wire: an inflow is never split across partners', () => {
    expect(getTool('book_capital_call')!.inputSchema.required).toEqual(['bankTransactionId', 'lpEntityId'])
  })
})

describe('settlement review input', () => {
  const valid = { kind: 'call', lineId: UUID_A, links: [{ entryId: UUID_B, amount: 80 }], separateRemainder: false }

  it('accepts a well-formed decision', () => {
    expect(settlementReviewProblem(valid)).toBeNull()
  })

  it('refuses a bad kind, a bad id, a non-positive amount, a missing flag or too many links', () => {
    expect(settlementReviewProblem({ ...valid, kind: 'fee' })).not.toBeNull()
    expect(settlementReviewProblem({ ...valid, lineId: 'x' })).not.toBeNull()
    expect(settlementReviewProblem({ ...valid, links: [{ entryId: UUID_B, amount: 0 }] })).not.toBeNull()
    expect(settlementReviewProblem({ ...valid, separateRemainder: undefined })).not.toBeNull()
    expect(settlementReviewProblem({ ...valid, links: Array.from({ length: 51 }, () => ({ entryId: UUID_B, amount: 1 })) })).not.toBeNull()
    expect(settlementReviewProblem(null)).not.toBeNull()
  })
})
