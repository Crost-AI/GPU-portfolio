import { describe, it, expect } from 'vitest'
import {
  buildPayeeEntry, buildPayerEntry,
  buildPayeeSettlementEntry, buildPayerSettlementEntry,
  isAccruingKind, INTERCOMPANY_KINDS, INTERCOMPANY_KIND_LABELS, pickIntercompanyAccounts,
  type ChargeInput, type SideAccounts,
} from './intercompany'
import { isBalanced, accountBalances } from './ledger'

const payee: SideAccounts = {
  intercompanyAccountId: 'manco-due-from-fund',
  cashAccountId: 'manco-cash',
  pnlAccountId: 'manco-fee-income',
}
const payer: SideAccounts = {
  intercompanyAccountId: 'fund-due-to-manco',
  cashAccountId: 'fund-cash',
  pnlAccountId: 'fund-fee-expense',
}

const charge = (over: Partial<ChargeInput> = {}): ChargeInput => ({
  fundId: 'f1',
  kind: 'management_fee',
  chargeDate: '2026-01-01',
  amount: 312_500,
  memo: 'Q1 2026 management fee',
  chargeId: 'ic-1',
  ...over,
})

describe('intercompany accrual — both sides of one charge', () => {
  it('books a receivable and income on the payee', () => {
    const e = buildPayeeEntry(charge(), payee)
    expect(isBalanced(e)).toBe(true)
    const bal = accountBalances(e.postings)
    expect(bal.get('manco-due-from-fund')).toBe(312_500) // debit: it is owed
    expect(bal.get('manco-fee-income')).toBe(-312_500)   // credit: it earned
  })

  it('books an expense and a payable on the payer', () => {
    const e = buildPayerEntry(charge(), payer)
    expect(isBalanced(e)).toBe(true)
    const bal = accountBalances(e.postings)
    expect(bal.get('fund-fee-expense')).toBe(312_500)  // debit: it incurred a cost
    expect(bal.get('fund-due-to-manco')).toBe(-312_500) // credit: it owes
  })

  it('agrees on the amount, which is the whole point of posting both from one input', () => {
    const input = charge()
    const a = accountBalances(buildPayeeEntry(input, payee).postings)
    const b = accountBalances(buildPayerEntry(input, payer).postings)
    expect(a.get('manco-due-from-fund')).toBe(-(b.get('fund-due-to-manco') as number))
  })

  it('tags both entries with the same charge so they can be reconciled', () => {
    const input = charge()
    for (const e of [buildPayeeEntry(input, payee), buildPayerEntry(input, payer)]) {
      expect(e.sourceType).toBe('intercompany')
      expect(e.sourceRef).toBe('intercompany:ic-1')
    }
  })

  it('does not touch the P&L on a cash kind — lending money is not income', () => {
    const input = charge({ kind: 'loan_advance', amount: 50_000 })
    const lender = accountBalances(buildPayeeEntry(input, payee).postings)
    expect(lender.get('manco-cash')).toBe(-50_000)          // cash out
    expect(lender.get('manco-due-from-fund')).toBe(50_000)  // balance created
    expect(lender.has('manco-fee-income')).toBe(false)

    const borrower = accountBalances(buildPayerEntry(input, payer).postings)
    expect(borrower.get('fund-cash')).toBe(50_000)          // cash in
    expect(borrower.get('fund-due-to-manco')).toBe(-50_000)
    expect(borrower.has('fund-fee-expense')).toBe(false)
  })

  it('refuses a zero or negative amount rather than posting a reversing charge', () => {
    expect(() => buildPayeeEntry(charge({ amount: 0 }), payee)).toThrow()
    expect(() => buildPayerEntry(charge({ amount: -1 }), payer)).toThrow()
  })

  it('refuses to guess when the chart has no account for the charge', () => {
    const noPnl = { ...payee, pnlAccountId: null }
    // Better a refusal than a plausible-looking entry in the wrong account: an intercompany
    // charge posted to the wrong income line still balances, so nothing downstream flags it.
    expect(() => buildPayeeEntry(charge(), noPnl)).toThrow(/income account/)
  })
})

describe('intercompany settlement — the cash moves and the balance clears', () => {
  const input = { ...charge(), settledDate: '2026-02-15' }

  it('clears the receivable into cash on the payee', () => {
    const e = buildPayeeSettlementEntry(input, payee)
    expect(isBalanced(e)).toBe(true)
    expect(e.entryDate).toBe('2026-02-15') // dated when the money moved, not when it was charged
    const bal = accountBalances(e.postings)
    expect(bal.get('manco-cash')).toBe(312_500)
    expect(bal.get('manco-due-from-fund')).toBe(-312_500)
  })

  it('clears the payable out of cash on the payer', () => {
    const e = buildPayerSettlementEntry(input, payer)
    expect(isBalanced(e)).toBe(true)
    const bal = accountBalances(e.postings)
    expect(bal.get('fund-due-to-manco')).toBe(312_500)
    expect(bal.get('fund-cash')).toBe(-312_500)
  })

  it('nets each side to zero once accrual and settlement are both posted', () => {
    // The invariant that makes the register trustworthy: a fully settled charge leaves nothing
    // outstanding on either intercompany account.
    const accrual = accountBalances(buildPayeeEntry(charge(), payee).postings)
    const settle = accountBalances(buildPayeeSettlementEntry(input, payee).postings)
    expect((accrual.get('manco-due-from-fund') ?? 0) + (settle.get('manco-due-from-fund') ?? 0)).toBe(0)
  })

  it('carries the charge tag so a settlement can be traced to what it paid', () => {
    expect(buildPayeeSettlementEntry(input, payee).sourceRef).toBe('intercompany-settlement:ic-1')
    expect(buildPayerSettlementEntry(input, payer).sourceRef).toBe('intercompany-settlement:ic-1')
    expect(buildPayeeSettlementEntry(input, payee).sourceType).toBe('intercompany_settlement')
  })
})

describe('the kind vocabulary', () => {
  it('labels every kind — an unlabelled one renders as a raw enum in the picker', () => {
    for (const k of INTERCOMPANY_KINDS) {
      expect(INTERCOMPANY_KIND_LABELS[k], `no label for ${k}`).toBeTruthy()
    }
  })

  it('splits accruing kinds from cash kinds', () => {
    expect(isAccruingKind('management_fee')).toBe(true)
    expect(isAccruingKind('expense_reimbursement')).toBe(true)
    expect(isAccruingKind('loan_advance')).toBe(false)
    expect(isAccruingKind('loan_repayment')).toBe(false)
  })
})

describe('pickIntercompanyAccounts', () => {
  const fund3 = 'aaaa1111-0000-0000-0000-000000000003'
  const fund2 = 'bbbb2222-0000-0000-0000-000000000002'
  const acct = (id: string, code: string, type: string, cp: string | null = null) => ({ id, code, type, counterparty_vehicle_id: cp })

  it('finds the code-convention accounts when nothing is linked', () => {
    const chart = [acct('r', '1900-aaaa1111', 'asset'), acct('p', '2900-aaaa1111', 'liability'), acct('x', '1900-bbbb2222', 'asset')]
    expect(pickIntercompanyAccounts(chart, fund3)).toEqual({ receivable: chart[0], payable: chart[1] })
  })

  it('prefers a linked account whatever its code or name', () => {
    const imported = acct('imp', '1907', 'asset', fund3)
    const chart = [acct('r', '1900-aaaa1111', 'asset'), imported]
    expect(pickIntercompanyAccounts(chart, fund3).receivable).toBe(imported)
    expect(pickIntercompanyAccounts(chart, fund3).payable).toBeNull()
  })

  it('finds nothing for an unlinked imported account', () => {
    expect(pickIntercompanyAccounts([acct('imp', '1907', 'asset')], fund3)).toEqual({ receivable: null, payable: null })
  })

  it('does not take a convention account that is linked to someone else', () => {
    const chart = [acct('r', '1900-aaaa1111', 'asset', fund2)]
    expect(pickIntercompanyAccounts(chart, fund3).receivable).toBeNull()
    expect(pickIntercompanyAccounts(chart, fund2).receivable).toBe(chart[0])
  })
})
