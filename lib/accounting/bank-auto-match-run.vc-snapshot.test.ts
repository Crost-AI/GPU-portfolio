import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import type { JournalEntry } from './types'

// ── GPU fleet (P3) ── autoMatchOpenCapital gained a payout path for GPU SPVs. A fund vehicle must
// take exactly the path it took before: the outcome below is the one the pre-P3 code produced for
// this fixture, with the same keys, the same drafts and the same bank-row updates, and the payout
// path is never entered (no gpu_payouts read, no 1150 in the chart).
const s = vi.hoisted(() => ({ m: null as any, receivables: [] as [string, number][], payables: [] as [string, number][], serial: 0 }))
vi.mock('./capital-calls', async orig => ({
  ...(await orig<any>()),
  lpReceivableBalances: async () => new Map(s.receivables),
  lpPayableBalances: async () => new Map(s.payables),
}))
vi.mock('./load', async orig => ({
  ...(await orig<any>()),
  loadEntityNames: async () => new Map([['lp-a', 'Alpha LP'], ['lp-b', 'Beta LP'], ['lp-c', 'Gamma LP']]),
}))
vi.mock('./persist', async orig => ({
  ...(await orig<any>()),
  persistEntry: vi.fn(async (_a: any, fundId: string, group: string, _u: string, entry: JournalEntry, status: 'draft' | 'posted' = 'posted') => {
    const t = s.m.tables
    const id = `je-${++s.serial}`
    const vehicle = t.fund_vehicles.find((v: any) => v.name === group)
    t.journal_entries.push({ id, fund_id: fundId, vehicle_id: vehicle.id, book: 'actual', status, entry_date: entry.entryDate, source_type: entry.sourceType, source_ref: entry.sourceRef ?? null, memo: entry.memo })
    for (const p of entry.postings) t.journal_postings.push({ journal_entry_id: id, fund_id: fundId, vehicle_id: vehicle.id, book: 'actual', account_id: p.accountId, amount: p.amount, lp_entity_id: p.lpEntityId ?? null })
    return { entryId: id }
  }),
}))
vi.mock('./bank-match', async orig => {
  const real = await orig<any>()
  return {
    ...real,
    marketplacePayoutCandidates: vi.fn(real.marketplacePayoutCandidates),
    linkInflowToEntry: vi.fn(async (_a: any, _f: string, _g: string, txnId: string, entryId: string) => {
      const t = s.m.tables
      t.journal_entries.find((e: any) => e.id === entryId).status = 'posted'
      Object.assign(t.bank_transactions.find((x: any) => x.id === txnId), { journal_entry_id: entryId, status: 'reconciled' })
      return { ok: true }
    }),
  }
})

import { autoMatchOpenCapital } from './bank-auto-match-run'
import { marketplacePayoutCandidates } from './bank-match'
import { GPU_SPV_CHART } from './chart'

const txn = (vehicle_id: string, id: string, amount: number, description: string, txn_date = '2026-10-03', status = 'drafted') =>
  ({ id, fund_id: 'f', vehicle_id, txn_date, amount, description, status, journal_entry_id: `draft-${id}` })
const placeholder = (vehicle_id: string, id: string) => ({ id: `draft-${id}`, fund_id: 'f', vehicle_id, book: 'actual', status: 'draft', entry_date: '2026-10-03' })

beforeEach(() => {
  vi.mocked(marketplacePayoutCandidates).mockClear()
  s.receivables = []
  s.payables = []
  s.serial = 0
})

describe('a fund vehicle: the pre-P3 outcome, unchanged', () => {
  beforeEach(() => {
    const chart = [['1000', 'asset'], ['1300', 'asset'], ['2300', 'liability']].map(([code, type]) => ({ id: `fund-${code}`, fund_id: 'f', vehicle_id: 'v-fund', code, type }))
    s.m = memoryAdmin({
      fund_vehicles: [{ id: 'v-fund', fund_id: 'f', name: 'Fund I', kind: 'fund', aliases: [] }],
      chart_of_accounts: chart,
      bank_transactions: [
        txn('v-fund', 't-1', 1000, 'Wire Alpha'), txn('v-fund', 't-2', 2500, 'Incoming wire'), txn('v-fund', 't-3', 777, 'Marketplace payout'),
        txn('v-fund', 't-4', -300, 'Distribution Gamma'), txn('v-fund', 't-5', 1000, 'Already done', '2026-10-03', 'reconciled'),
      ],
      journal_entries: ['t-1', 't-2', 't-3', 't-4', 't-5'].map(id => placeholder('v-fund', id)),
      journal_postings: [], capital_call_lines: [],
      // A payout row the fund can never have; the fund path must not read it.
      gpu_payouts: [{ id: 'p-x', fund_id: 'f', vehicle_id: 'v-fund', payout_date: '2026-10-01', amount: 777, status: 'expected' }],
    })
    s.receivables = [['lp-a', 1000], ['lp-b', 2500], ['lp-c', 2500]]
    s.payables = [['lp-c', 300]]
  })

  it('matches, asks and skips exactly as before, with no payout keys and no payout read', async () => {
    const out = await autoMatchOpenCapital(s.m.admin, 'f', 'Fund I', 'u')
    expect(out).toEqual({
      matched: [
        { txnId: 't-1', lpEntityId: 'lp-a', name: 'Alpha LP', amount: 1000, by: 'amount' },
        { txnId: 't-4', lpEntityId: 'lp-c', name: 'Gamma LP', amount: -300, by: 'amount' },
      ],
      ambiguous: [{
        txnId: 't-2', amount: 2500, description: 'Incoming wire',
        candidates: [{ lpEntityId: 'lp-b', name: 'Beta LP', amount: 2500, references: [] }, { lpEntityId: 'lp-c', name: 'Gamma LP', amount: 2500, references: [] }],
      }],
      unmatched: 1,
    })
    expect(Object.keys(out)).toEqual(['matched', 'ambiguous', 'unmatched'])
    expect(marketplacePayoutCandidates).not.toHaveBeenCalled()

    const t = s.m.tables
    expect(t.journal_entries.filter((e: any) => !e.id.startsWith('draft-')).map((e: any) => [e.status, e.memo])).toEqual([
      ['draft', 'Funding — Alpha LP — Wire Alpha'],
      ['draft', 'Distribution paid — Gamma LP — Distribution Gamma'],
    ])
    // The placeholders of the two matched rows are retired; the others are untouched.
    expect(t.journal_entries.map((e: any) => e.id).filter((id: string) => id.startsWith('draft-'))).toEqual(['draft-t-2', 'draft-t-3', 'draft-t-5'])
    expect(t.bank_transactions.map((b: any) => [b.id, b.status, b.journal_entry_id, b.suggested_account_code ?? null])).toEqual([
      ['t-1', 'drafted', 'je-1', '1300'], ['t-2', 'drafted', 'draft-t-2', null], ['t-3', 'drafted', 'draft-t-3', null],
      ['t-4', 'drafted', 'je-2', '2300'], ['t-5', 'reconciled', 'draft-t-5', null],
    ])
    expect(t.gpu_payouts[0].status).toBe('expected')
  })
})

describe('a GPU SPV: expected marketplace payouts', () => {
  beforeEach(() => {
    s.m = memoryAdmin({
      fund_vehicles: [{ id: 'v-gpu', fund_id: 'f', name: 'GPU I', kind: 'gpu_spv', aliases: [] }],
      chart_of_accounts: GPU_SPV_CHART.map(a => ({ id: `gpu-${a.code}`, fund_id: 'f', vehicle_id: 'v-gpu', portfolio_group: 'GPU I', code: a.code, name: a.name, type: a.type })),
      bank_transactions: [
        txn('v-gpu', 't-1', 1000, 'Payout'), txn('v-gpu', 't-2', 2000, 'Payout'),
        txn('v-gpu', 't-3', 5000, 'Incoming wire'), txn('v-gpu', 't-4', 300, 'Wire Beta'),
      ],
      journal_entries: ['t-1', 't-2', 't-3', 't-4'].map(id => placeholder('v-gpu', id)),
      journal_postings: [], capital_call_lines: [],
      gpu_payouts: [
        { id: 'p-1', fund_id: 'f', vehicle_id: 'v-gpu', payout_date: '2026-10-01', amount: 1000, reference: null, status: 'expected' },
        { id: 'p-2', fund_id: 'f', vehicle_id: 'v-gpu', payout_date: '2026-10-01', amount: 2000, reference: null, status: 'expected' },
        { id: 'p-3', fund_id: 'f', vehicle_id: 'v-gpu', payout_date: '2026-10-02', amount: 2000, reference: null, status: 'expected' },
        { id: 'p-4', fund_id: 'f', vehicle_id: 'v-gpu', payout_date: '2026-10-01', amount: 5000, reference: null, status: 'expected' },
      ],
    })
    // lp-a's open call is the same amount as payout p-4.
    s.receivables = [['lp-a', 5000], ['lp-b', 300]]
  })

  it('posts an inflow that fits one payout; asks about two payouts, and about a payout that collides with an open call', async () => {
    const out = await autoMatchOpenCapital(s.m.admin, 'f', 'GPU I', 'u')
    if ('error' in out) throw new Error(out.error)
    const t = s.m.tables

    expect(out.payouts).toEqual([{ txnId: 't-1', payoutId: 'p-1', amount: 1000, entryId: expect.any(String) }])
    const entry = t.journal_entries.find((e: any) => e.id === out.payouts![0].entryId)
    expect(entry).toMatchObject({ status: 'posted', source_ref: 'marketplace-payout:p-1', entry_date: '2026-10-03' })
    expect(t.gpu_payouts.find((p: any) => p.id === 'p-1')).toMatchObject({ status: 'matched', bank_transaction_id: 't-1' })

    expect(out.ambiguousPayouts).toEqual([
      { txnId: 't-2', amount: 2000, description: 'Payout', candidates: [expect.objectContaining({ payoutId: 'p-2' }), expect.objectContaining({ payoutId: 'p-3' })] },
      // Same amount as an open capital call: neither booked, both listed.
      {
        txnId: 't-3', amount: 5000, description: 'Incoming wire',
        candidates: [expect.objectContaining({ payoutId: 'p-4' })],
        lpCandidates: [{ lpEntityId: 'lp-a', name: 'Alpha LP', amount: 5000, references: [] }],
      },
    ])
    expect(t.gpu_payouts.find((p: any) => p.id === 'p-4').status).toBe('expected')
    expect(t.bank_transactions.find((b: any) => b.id === 't-3')).toMatchObject({ status: 'drafted', journal_entry_id: 'draft-t-3' })
    expect(out.matched).toEqual([{ txnId: 't-4', lpEntityId: 'lp-b', name: 'Beta LP', amount: 300, by: 'amount' }])
    expect(out.ambiguous).toEqual([])
  })
})
