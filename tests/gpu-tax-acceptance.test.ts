import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { A, B, GROUP, gpuTaxYear, ledgerWriter } from '@/tests/helpers/gpu-tax-year'
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

const balanceIn = (book: string, account: string) => {
  const voided = new Set(s.m.tables.journal_entries.filter((e: any) => e.status === 'void').map((e: any) => e.id))
  return s.m.tables.journal_postings.filter((p: any) => p.book === book && p.account_id === account && !voided.has(p.journal_entry_id)).reduce((t: number, p: any) => t + Number(p.amount), 0)
}

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

const run = async (taxYear: number, opts?: { preview?: boolean }) => {
  const r = await postTaxAdjustments(s.m.admin, 'f', GROUP, 'u', taxYear, opts)
  if ('error' in r) throw new Error(r.error)
  return r
}
/** The year's K-1 character, after asserting every partner ties to tax capital and Item L foots. */
const k1Tied = async (taxYear: number) => {
  const inputs = await loadK1Year(s.m.admin, 'f', GROUP, taxYear)
  if ('error' in inputs) throw new Error(inputs.error)
  const { partners, unallocated } = allocateK1(inputs)
  expect(unallocated).toEqual({})
  for (const p of partners) {
    expect(p.tieOut.variance).toBe(0)
    expect(capitalAccountFoots(p).variance).toBe(0)
  }
  return inputs.fund
}
const both = (account: string) => balanceIn('actual', account) + balanceIn('tax', account)
const accA = `1650-${A.slice(0, 8)}`
const accB = `1650-${B.slice(0, 8)}`

describe('book depreciation is the year\'s P&L, by journal date (cross-year)', () => {
  it('a December charge the close caught up in January is next year\'s book expense, and is deducted once', async () => {
    s.m = memoryAdmin(gpuTaxYear({ catchUpDecember: true, year2028: {} }))
    await run(2027)
    // 2027 carries eleven months of A (16,500) and nine of B: the return still deducts MACRS, 20,000.
    expect(await k1Tied(2027)).toMatchObject({ businessDeductions: 7_500 + 20_000 })
    await run(2028)
    // 2028's P&L carries thirteen months of A (19,500). MACRS year 2 is 32,000 — not 33,500.
    expect(await k1Tied(2028)).toMatchObject({ businessDeductions: 32_000 })
    expect(both(accA)).toBe(-(20_000 + 32_000))
  })

  it('a 2027 charge reversed in 2028 is 2027 expense and a 2028 credit, and the return still deducts MACRS each year', async () => {
    s.m = memoryAdmin(gpuTaxYear({ year2028: {} }))
    const t = s.m.tables
    const nov = t.journal_entries.find((e: any) => e.source_ref === `gpu-dep:${A}:2027-11`)
    const { je, allocate } = ledgerWriter(t)
    je('reversal', '2028-01-10', `reversal:${nov.id}`, [['g-5300', -1_500], [accA, 1_500]])
    allocate('partnership_expense', '2028-01-10', -1_500)
    await run(2027)
    expect(await k1Tied(2027)).toMatchObject({ businessDeductions: 7_500 + 20_000 })
    await run(2028)
    // 2028's P&L: twelve months (18,000) less the reversal (1,500); the difference makes it 32,000.
    expect(await k1Tied(2028)).toMatchObject({ businessDeductions: 32_000 })
    expect(both(accA)).toBe(-(20_000 + 32_000))
  })
})

describe('a disposal clears only a difference the earlier years put in the tax book', () => {
  // A: 18,000 book / 20,000 tax in 2027; sold 30 September 2028 after 13,500 book / 16,000 tax.
  beforeEach(() => { s.m = memoryAdmin(gpuTaxYear({ year2028: { sellA: true } })) })

  it('refuses the disposal year when the year before was never run, naming the year to run', async () => {
    for (const opts of [undefined, { preview: true }]) {
      const r = await postTaxAdjustments(s.m.admin, 'f', GROUP, 'u', 2028, opts)
      expect(r).toEqual({ error: expect.stringContaining('H200 #1 2027: difference 2,000.00, tax book holds 0.00') })
      expect((r as { error: string }).error).toMatch(/Run the book-to-tax adjustments for 2027 first, in order, then rerun 2028\./)
    }
    expect(s.m.tables.journal_entries.filter((e: any) => e.book === 'tax')).toEqual([])
  })

  it('with 2027 run first, the sold server\'s 1650 ends at nil and the K-1 carries the gain at tax basis', async () => {
    await run(2027)
    await run(2028)
    expect(both(accA)).toBe(0)
    // Tax basis 100,000 less 36,000 is 64,000; sold for 70,000: a 6,000 gain (1,500 on the books).
    expect(await k1Tied(2028)).toMatchObject({ businessDeductions: 16_000, section1231Gain: 6_000 })
  })

  it('a prior-year rerun after the disposal run that changes nothing leaves the disposal run standing', async () => {
    await run(2027)
    await run(2028)
    const again = await run(2027)
    expect(again.rerun).toBeUndefined()
    expect(both(accA)).toBe(0)
    expect((await run(2028)).voided).toBe(2)
    expect(both(accA)).toBe(0)
  })

  it('a prior year that changed after the disposal run: the disposal year refuses until it is rerun, which names the disposal year to rerun', async () => {
    await run(2027)
    await run(2028)
    // The preparer corrects A to 40% bonus: 2027 is now 52,000 of tax depreciation, not 20,000.
    Object.assign(s.m.tables.gpu_assets.find((a: any) => a.id === A), { tax_method: 'bonus', tax_bonus_pct: 0.4 })
    const stale = await postTaxAdjustments(s.m.admin, 'f', GROUP, 'u', 2028)
    expect(stale).toEqual({ error: expect.stringContaining('H200 #1 2027: difference 34,000.00, tax book holds 2,000.00') })

    const rerun2027 = await run(2027)
    expect(rerun2027.rerun).toEqual([{ taxYear: 2028, reason: expect.stringContaining('H200 #1') }])
    expect(both(accA)).not.toBe(0)
    await run(2028)
    expect(both(accA)).toBe(0)
    await k1Tied(2027)
    await k1Tied(2028)
  })
})

describe('servers whose differences offset still each get theirs (fleet total nil)', () => {
  it('+2,000 on one server and −2,000 on another post to each 1650, with nothing on the P&L or capital', async () => {
    const t = gpuTaxYear()
    const drop = (ref: string) => {
      const ids = new Set(t.journal_entries.filter(e => e.source_ref === ref).map(e => e.id))
      t.journal_entries = t.journal_entries.filter(e => !ids.has(e.id))
      t.journal_postings = t.journal_postings.filter(p => !ids.has(p.journal_entry_id))
    }
    // B is held all year, and its books carry 22,000 (an extra 4,000 in December) against MACRS 20,000.
    for (const ref of [`gpu-asset:${B}:disposal`, 'allocation:realized_gain:2027-12-31', 'allocation:partnership_expense:2027-12-31']) drop(ref)
    Object.assign(t.gpu_assets.find(a => a.id === B)!, { status: 'in_service', disposed_on: null })
    const { je, allocate } = ledgerWriter(t as any)
    for (const m of [10, 11, 12]) je('depreciation', new Date(Date.UTC(2027, m, 0)).toISOString().slice(0, 10), `gpu-dep:${B}:2027-${m}`, [['g-5300', 1_500], [accB, -1_500]])
    je('depreciation', '2027-12-31', `gpu-dep:${B}:2027-12:2`, [['g-5300', 4_000], [accB, -4_000]])
    allocate('partnership_expense', '2027-12-31', 18_000 + 22_000 + 7_500)
    s.m = memoryAdmin(t)

    const r = await run(2027)
    expect(r.proposals.map(p => [p.kind, p.amount, p.assets?.map(a => a.difference)])).toEqual([['depreciation', 0, [2_000, -2_000]]])
    expect([r.entryIds.length, r.skipped]).toEqual([1, []])
    const posted = s.m.tables.journal_postings.filter((p: any) => p.book === 'tax').map((p: any) => [p.account_id, p.amount])
    expect(posted).toEqual([[accA, -2_000], [accB, 2_000]])
    expect([both(accA), both(accB)]).toEqual([-20_000, -20_000])
    expect(await k1Tied(2027)).toMatchObject({ businessDeductions: 7_500 + 40_000 })
  })
})

describe('a manual depreciation correction is book depreciation too', () => {
  it('a manual Dr 5300 / Cr 1650 correction, and its reversal the next year, count in the years they are dated', async () => {
    s.m = memoryAdmin(gpuTaxYear({ year2028: {} }))
    const { je, allocate } = ledgerWriter(s.m.tables)
    // 2,000 of extra book depreciation on A in 2027, by hand; reversed on 15 January 2028.
    const fix = je('manual', '2027-12-31', null, [['g-5300', 2_000], [accA, -2_000]])
    allocate('partnership_expense', '2027-12-30', 2_000)
    je('reversal', '2028-01-15', `reversal:${fix}`, [['g-5300', -2_000], [accA, 2_000]])
    allocate('partnership_expense', '2028-01-15', -2_000)

    const r2027 = await run(2027)
    // A's books carry 20,000 (18,000 generated + 2,000 by hand) against MACRS 20,000: no difference.
    expect(r2027.proposals.find(p => p.kind === 'depreciation')?.assets?.map(a => [a.assetId, a.book, a.tax])).toEqual([[B, 13_500, 0]])
    expect(await k1Tied(2027)).toMatchObject({ businessDeductions: 7_500 + 20_000 })
    await run(2028)
    // 2028's P&L: 18,000 less the 2,000 reversal. The return deducts MACRS year 2, 32,000.
    expect(await k1Tied(2028)).toMatchObject({ businessDeductions: 32_000 })
    expect(both(accA)).toBe(-(20_000 + 32_000))
  })
})

describe('a fleet run that cannot build every difference posts none of them', () => {
  it('no expense weights but gain weights: refuses before voiding or posting, and the preview says why', async () => {
    s.m = memoryAdmin(gpuTaxYear({ year2028: { sellA: true } }))
    await run(2027)
    await run(2028)
    const t = s.m.tables
    const live2028 = () => t.journal_entries.filter((e: any) => e.book === 'tax' && e.source_ref === 'tax:2028' && e.status === 'posted').map((e: any) => e.id)
    const before = live2028()
    expect(before).toHaveLength(2)
    // The close's 2028 expense allocation is gone (say, the books' depreciation had run out): the
    // disposal gain still has partners, the depreciation difference has none to follow.
    const ids = new Set(t.journal_entries.filter((e: any) => e.source_ref === 'allocation:partnership_expense:2028-12-31').map((e: any) => e.id))
    t.journal_entries = t.journal_entries.filter((e: any) => !ids.has(e.id))
    t.journal_postings = t.journal_postings.filter((p: any) => !ids.has(p.journal_entry_id))

    const preview = await run(2028, { preview: true })
    expect(preview.skipped.map(k => k.kind)).toEqual(['depreciation'])
    const posted = await postTaxAdjustments(s.m.admin, 'f', GROUP, 'u', 2028)
    expect(posted).toEqual({ error: expect.stringMatching(/^Nothing was posted for 2028: No partner was allocated this year’s expenses/) })
    // The last complete run stands: nothing voided, nothing new.
    expect(live2028()).toEqual(before)
    expect(both(accA)).toBe(0)
  })
})
