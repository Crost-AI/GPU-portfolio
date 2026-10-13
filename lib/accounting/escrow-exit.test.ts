import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildEntryForTransaction } from './from-portfolio'
import { accountIdByCode } from './persist'
import { loadPostedLedger } from './load'
import { computeSummary } from '@/lib/investments'
import { realizedGains } from './realized-gains'
import { classifyEscrowExit, needsReview } from './escrow-exit-review'
import { proceedsSplit, escrowExceedsGross } from '@/lib/portfolio/proceeds'
import { transactionRowError } from '@/lib/portfolio/transaction-checks'
import { escrowRebookNote } from '@/lib/portfolio/transaction-edit'

/**
 * `proceeds_received` is the GROSS proceeds of an exit, escrow included (lib/portfolio/proceeds.ts).
 * The ledger books gross − escrow to cash and the escrow to 1350, so its realized gain is gross −
 * basis — the figure the tracker and the realized-gains report already used.
 */
vi.mock('./persist', () => ({ accountIdByCode: vi.fn(), persistEntry: vi.fn() }))
vi.mock('./load', () => ({ loadPostedLedger: vi.fn() }))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: vi.fn(async () => 'veh-1'), ensureVehiclesByName: vi.fn() }))
vi.mock('./vehicle-domain', () => ({ vehicleKindByName: vi.fn(async () => 'fund') }))
vi.mock('./provision-accounts', () => ({ ensureVehicleAccounts: vi.fn() }))
vi.mock('./investments', () => ({
  ensureInvestmentAccounts: vi.fn(async () => new Map([['co-1', { costId: 'cost', unrealizedId: 'unreal', fxId: 'fx', realizedId: 'gain-co' }]])),
}))

// Every query resolves to no rows: no draft entries, nothing excluded.
const chain: any = new Proxy({}, {
  get: (_t, prop) => prop === 'then' ? (resolve: any) => resolve({ data: [], error: null }) : () => chain,
})
const admin = { from: () => chain } as any

const purchase = {
  id: 'b1', company_id: 'co-1', portfolio_group: 'Fund I', transaction_date: '2024-01-15',
  transaction_type: 'investment', round_name: 'Seed', investment_cost: 1_000_000, shares_acquired: 100_000, share_price: 10,
}
// Sold for 3m gross; 500k of it held back in escrow, 2.5m wired on the day.
const exit = {
  id: 'x1', company_id: 'co-1', portfolio_group: 'Fund I', transaction_date: '2026-06-30',
  transaction_type: 'proceeds', round_name: 'Seed', shares_acquired: 100_000,
  cost_basis_exited: 1_000_000, proceeds_received: 3_000_000, proceeds_escrow: 500_000,
}
const receipt = {
  id: 'r1', company_id: 'co-1', portfolio_group: 'Fund I', transaction_date: '2027-06-30',
  transaction_type: 'escrow_receipt', round_name: 'Seed', proceeds_received: 500_000,
}

const bal = (postings: { accountId: string; amount: number }[], id: string) =>
  Math.round(postings.filter(p => p.accountId === id).reduce((s, p) => s + p.amount, 0) * 100) / 100

beforeEach(() => {
  // No 4200 on the chart, so the records-gap true-up (a 1200/4200 matter) stays out of it.
  vi.mocked(accountIdByCode).mockResolvedValue(new Map([['1000', 'cash'], ['1350', 'escrow'], ['4000', 'gain']]))
  vi.mocked(loadPostedLedger).mockResolvedValue({
    accounts: [], capitalPostings: [],
    postings: [{ accountId: 'cost', amount: 1_000_000 }, { accountId: 'cash', amount: -1_000_000 }],
  } as any)
})

describe('an exit with escrow — ledger and tracker agree', () => {
  it('books gross − escrow to cash, the escrow to 1350, and gross − basis as gain', async () => {
    const r: any = await buildEntryForTransaction(admin, 'f1', exit, 'Sports Co')
    const p = r.entry.postings
    expect(bal(p, 'cash')).toBe(2_500_000)
    expect(bal(p, 'escrow')).toBe(500_000)
    expect(bal(p, 'cost')).toBe(-1_000_000)
    expect(bal(p, 'gain-co')).toBe(-2_000_000)
    expect(p.reduce((s: number, x: any) => s + x.amount, 0)).toBeCloseTo(0, 6)
    expect(r).toMatchObject({ kind: 'proceeds', amount: 2_500_000 })
  })

  it("the ledger's realized gain equals the tracker's and the realized-gains report's", async () => {
    const r: any = await buildEntryForTransaction(admin, 'f1', exit, 'Sports Co')
    const ledgerGain = -bal(r.entry.postings, 'gain-co')

    const s = computeSummary([purchase, exit] as any, 'exited')
    const trackerGain = s.totalRealized - s.rounds.reduce((sum, x) => sum + x.costBasisExited, 0)

    const report = realizedGains([purchase, exit] as any, [{ id: 'co-1', name: 'Sports Co' }], 'fifo')

    expect(trackerGain).toBe(2_000_000)
    expect(ledgerGain).toBe(trackerGain)
    expect(report.totals.gain).toBe(trackerGain)
    expect(report.totals.proceeds).toBe(3_000_000)
  })

  it('the escrow receipt clears 1350, and cash ends at the gross with no second gain', async () => {
    const atExit: any = await buildEntryForTransaction(admin, 'f1', exit, 'Sports Co')
    const onReceipt: any = await buildEntryForTransaction(admin, 'f1', receipt, 'Sports Co')
    const all = [...atExit.entry.postings, ...onReceipt.entry.postings]
    expect(bal(all, 'escrow')).toBe(0)
    expect(bal(all, 'cash')).toBe(3_000_000)
    expect(bal(all, 'gain-co')).toBe(-2_000_000)
  })

  it('books cash only on a chart without 1350; the receipt books the rest as gain', async () => {
    vi.mocked(accountIdByCode).mockResolvedValue(new Map([['1000', 'cash'], ['4000', 'gain']]))
    const atExit: any = await buildEntryForTransaction(admin, 'f1', exit, 'Sports Co')
    expect(bal(atExit.entry.postings, 'cash')).toBe(2_500_000)
    expect(bal(atExit.entry.postings, 'gain-co')).toBe(-1_500_000)
    const onReceipt: any = await buildEntryForTransaction(admin, 'f1', receipt, 'Sports Co')
    expect(bal([...atExit.entry.postings, ...onReceipt.entry.postings], 'gain-co')).toBe(-2_000_000)
  })

  it('refuses an exit whose escrow is larger than its gross rather than book negative cash', async () => {
    const r: any = await buildEntryForTransaction(admin, 'f1', { ...exit, proceeds_received: 100_000 }, 'Sports Co')
    expect(r.skip.reason).toMatch(/gross/i)
  })
})

describe('proceeds — one meaning', () => {
  it('splits gross into cash and escrow', () => {
    expect(proceedsSplit({ proceeds_received: 3_000_000, proceeds_escrow: 500_000 })).toEqual({ gross: 3_000_000, escrow: 500_000, cash: 2_500_000 })
    expect(proceedsSplit({ proceeds_received: null, proceeds_escrow: null })).toEqual({ gross: 0, escrow: 0, cash: 0 })
  })

  it('refuses escrow larger than the gross on save and on edit', () => {
    const row = { transaction_type: 'proceeds', proceeds_received: 100, proceeds_escrow: 500 }
    expect(escrowExceedsGross(row)).toMatch(/gross/i)
    expect(transactionRowError(row)).toMatch(/gross/i)
    expect(escrowExceedsGross({ ...row, proceeds_received: 500 })).toBeNull()
    expect(escrowExceedsGross({ transaction_type: 'escrow_receipt', proceeds_received: 100, proceeds_escrow: 500 })).toBeNull()
  })

  it('tells the editor what a re-booked exit with escrow put in cash', () => {
    expect(escrowRebookNote(exit)).toMatch(/2,500,000\.00 to cash.*500,000\.00 to the escrow receivable/)
    expect(escrowRebookNote({ ...exit, proceeds_escrow: 0 })).toBeNull()
    expect(escrowRebookNote(receipt)).toBeNull()
  })
})

describe('classifyEscrowExit — what the owner reviews', () => {
  const t = { proceeds_received: 3_000_000, proceeds_escrow: 500_000, cost_basis_exited: 1_000_000 }

  it('booked by the gross rule: nothing to review', () => {
    const c = classifyEscrowExit(t, { cash: 2_500_000, escrow: 500_000, gain: 2_000_000 })
    expect(c.reading).toBe('gross')
    expect(c.cashDifference).toBe(0)
    expect(needsReview(c)).toBe(false)
  })

  it('booked the old way (proceeds as cash, escrow on top): review, cash differs by the escrow', () => {
    const c = classifyEscrowExit(t, { cash: 3_000_000, escrow: 500_000, gain: 2_500_000 })
    expect(c.reading).toBe('old_rule')
    expect(c.cashDifference).toBe(500_000)
    expect(c.expected).toEqual({ cash: 2_500_000, escrow: 500_000, gain: 2_000_000 })
    expect(needsReview(c)).toBe(true)
  })

  it('booked the old way on a chart without 1350', () => {
    expect(classifyEscrowExit(t, { cash: 3_000_000, escrow: 0, gain: 2_000_000 }).reading).toBe('old_rule_no_1350')
  })

  it('not on the ledger, or changed by hand', () => {
    expect(classifyEscrowExit(t, null).reading).toBe('not_on_ledger')
    expect(needsReview({ reading: 'not_on_ledger' })).toBe(false)
    expect(classifyEscrowExit(t, { cash: 1_234, escrow: 0, gain: 0 }).reading).toBe('other')
  })
})
