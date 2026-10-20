import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { A, B, GROUP, gpuTaxYear } from '@/tests/helpers/gpu-tax-year'
import type { JournalEntry } from '@/lib/accounting/types'

/**
 * ── GPU fleet (P1c) ── Acceptance (#68): a GPU SPV's tax year — rental revenue, operating costs
 * (insurance and repairs on 5200/5250 among them), book depreciation against 5-year MACRS, and a
 * server sold in the year — runs through the book-to-tax adjustments and comes out as K-1s that tie
 * to each partner's tax capital with zero variance and an Item L that foots.
 */

const s = vi.hoisted(() => ({ m: null as any }))
vi.mock('@/lib/accounting/persist', async orig => ({
  ...(await orig<any>()),
  persistEntry: vi.fn(async (_a: any, fundId: string, _g: string, _u: string, entry: JournalEntry, status: string, book: string) => {
    const t = s.m.tables
    const id = `je-tax-${t.journal_entries.length + 1}`
    t.journal_entries.push({ id, fund_id: fundId, vehicle_id: 'v-gpu', book, status, entry_date: entry.entryDate, source_type: entry.sourceType, source_ref: entry.sourceRef ?? null })
    for (const p of entry.postings) {
      t.journal_postings.push({ id: `jp-tax-${t.journal_postings.length + 1}`, journal_entry_id: id, fund_id: fundId, vehicle_id: 'v-gpu', book, account_id: p.accountId, amount: p.amount, lp_entity_id: p.lpEntityId ?? null })
    }
    return { entryId: id }
  }),
}))

import { postTaxAdjustments } from '@/lib/accounting/book-tax-run'
import { loadK1Year } from '@/lib/accounting/k1-load'
import { allocateK1, capitalAccountFoots } from '@/lib/accounting/k1-allocation'

beforeEach(() => { s.m = memoryAdmin(gpuTaxYear()) })

const balanceIn = (book: string, account: string) =>
  s.m.tables.journal_postings.filter((p: any) => p.book === book && p.account_id === account).reduce((t: number, p: any) => t + Number(p.amount), 0)

describe('a GPU SPV tax year, end to end', () => {
  it('posts the tax book and issues K-1s that tie to tax capital with zero variance', async () => {
    const run = await postTaxAdjustments(s.m.admin, 'f', GROUP, 'u', 2027)
    if ('error' in run) throw new Error(run.error)
    expect(run.proposals.map(p => [p.kind, p.amount])).toEqual([['depreciation', -11_500], ['disposal_basis', 13_500]])
    expect([run.entryIds.length, run.skipped, run.missingAccounts]).toEqual([2, [], []])
    expect(s.m.tables.journal_entries.filter((e: any) => e.book === 'tax').map((e: any) => e.source_ref)).toEqual(['tax:2027', 'tax:2027'])

    // Actual + tax is the return: 20,000 of depreciation (MACRS on the server held), and the sold
    // server's accumulated depreciation cleared in the tax book.
    expect(balanceIn('actual', 'g-5300') + balanceIn('tax', 'g-5300')).toBe(20_000)
    expect(balanceIn('actual', `1650-${A.slice(0, 8)}`) + balanceIn('tax', `1650-${A.slice(0, 8)}`)).toBe(-20_000)
    expect(balanceIn('tax', `1650-${B.slice(0, 8)}`)).toBe(0)

    const inputs = await loadK1Year(s.m.admin, 'f', GROUP, 2027)
    if ('error' in inputs) throw new Error(inputs.error)
    expect(inputs.fund).toMatchObject({
      businessIncome: 60_000,
      // 6,000 datacenter + 1,000 insurance + 500 repairs + 20,000 tax depreciation.
      businessDeductions: 27_500,
      // A book gain of 3,500 is a tax loss of 10,000: the server left at its 100,000 tax basis.
      section1231Gain: -10_000,
      deductions: 0, interest: 0,
    })

    const { partners, unallocated } = allocateK1(inputs)
    expect(unallocated).toEqual({})
    const a = partners.find(p => p.lpEntityId === 'lp-a')!
    const b = partners.find(p => p.lpEntityId === 'lp-b')!
    expect([a.lines.ordinaryBusinessIncome, a.lines.section1231Gain]).toEqual([19_500, -6_000])
    expect([b.lines.ordinaryBusinessIncome, b.lines.section1231Gain]).toEqual([13_000, -4_000])
    for (const p of [a, b]) {
      expect(p.tieOut.variance).toBe(0)
      expect(capitalAccountFoots(p).variance).toBe(0)
    }
    // Tax capital: contributions plus box 1 and box 10.
    expect([a.capitalAccount.ending, b.capitalAccount.ending]).toEqual([120_000 + 19_500 - 6_000, 80_000 + 13_000 - 4_000])
  })

  it('a re-run voids what the last run wrote and posts the same set again', async () => {
    await postTaxAdjustments(s.m.admin, 'f', GROUP, 'u', 2027)
    const again = await postTaxAdjustments(s.m.admin, 'f', GROUP, 'u', 2027)
    if ('error' in again) throw new Error(again.error)
    expect(again.voided).toBe(2)
    const inputs = await loadK1Year(s.m.admin, 'f', GROUP, 2027)
    if ('error' in inputs) throw new Error(inputs.error)
    expect(inputs.fund).toMatchObject({ businessDeductions: 27_500, section1231Gain: -10_000 })
    for (const p of allocateK1(inputs).partners) expect(p.tieOut.variance).toBe(0)
  })
})
