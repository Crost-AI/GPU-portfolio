import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import type { JournalEntry } from '@/lib/accounting/types'

// persistEntry stands in for the ledger with its real lifecycle: a DRAFT header and its postings
// first, then the flip to posted (or, on failure, the draft deleted). `s.between` runs once inside
// that draft window, so a test can interleave a second request there; `s.failAfterDraft` makes this
// request fail and delete its draft; `s.after` runs once after the flip. A repeated live source_ref
// is refused the way the once-only index does, naming the entry already there.
const s = vi.hoisted(() => ({ m: null as any, between: null as null | (() => Promise<void>), failAfterDraft: false, after: null as null | (() => void) }))
vi.mock('@/lib/accounting/persist', () => ({
  persistEntry: vi.fn(async (_a: any, fundId: string, _g: string, _u: string, entry: JournalEntry) => {
    const t = s.m.tables
    const dup = entry.sourceRef && t.journal_entries.find((e: any) => e.source_ref === entry.sourceRef && e.status !== 'void')
    if (dup) return { error: 'already in the books', duplicateOf: dup.id }
    const id = `je-${t.journal_entries.length + 1}`
    const header = { id, fund_id: fundId, vehicle_id: 'v-gpu', book: 'actual', status: 'draft', entry_date: entry.entryDate, source_type: entry.sourceType, source_ref: entry.sourceRef, memo: entry.memo }
    t.journal_entries.push(header)
    for (const p of entry.postings) t.journal_postings.push({ id: `jp-${t.journal_postings.length + 1}`, journal_entry_id: id, fund_id: fundId, vehicle_id: 'v-gpu', book: 'actual', account_id: p.accountId, amount: p.amount, currency: 'USD', lp_entity_id: null })
    if (s.between) { const run = s.between; s.between = null; await run() }
    if (s.failAfterDraft) {
      s.failAfterDraft = false
      t.journal_entries.splice(t.journal_entries.indexOf(header), 1)
      t.journal_postings = t.journal_postings.filter((p: any) => p.journal_entry_id !== id)
      return { error: 'posting failed' }
    }
    header.status = 'posted'
    if (s.after) { const run = s.after; s.after = null; run() }
    return { entryId: id }
  }),
}))

import { capitalizeCost, ensureAssetAccounts, listAssets, parseAssetInput, purchaseAsset } from './assets'
import { disposeAsset } from './disposal'
import { buildDepreciationEntry } from './entries'
import { depreciableFromAsset, depreciationEntryDate, depreciationSchedule } from './depreciation'
import { persistEntry } from '@/lib/accounting/persist'
import { GPU_SPV_CHART } from '@/lib/accounting/chart'
import type { GpuAssetRow } from './types'

const ASSET_ID = 'abcdef12-0000-4000-8000-000000000001'
const ctx = { fundId: 'f', group: 'H200 SPV I', vehicleId: 'v-gpu', userId: 'u' }

beforeEach(() => {
  s.between = null; s.failAfterDraft = false; s.after = null
  s.m = memoryAdmin({
    fund_vehicles: [
      { id: 'v-gpu', fund_id: 'f', name: 'H200 SPV I', kind: 'gpu_spv', aliases: [] },
      { id: 'v-gpu2', fund_id: 'f', name: 'H200 SPV II', kind: 'gpu_spv', aliases: [] },
    ],
    chart_of_accounts: GPU_SPV_CHART.map(a => ({ id: `acc-${a.code}`, fund_id: 'f', vehicle_id: 'v-gpu', portfolio_group: 'H200 SPV I', code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null })),
    gpu_assets: [], journal_entries: [], journal_postings: [],
  }, { unique: [{ table: 'chart_of_accounts', key: r => `${r.fund_id}|${r.portfolio_group}|${r.code}` }] })
})

const created = (over: Partial<GpuAssetRow> = {}): GpuAssetRow => {
  const parsed = parseAssetInput({ name: 'H200 #1', gpu_count: 8, hardware_cost: 335_000, in_service_date: '2027-01-15' }, false)
  if ('error' in parsed) throw new Error(parsed.error)
  const row = {
    id: ASSET_ID, fund_id: 'f', vehicle_id: 'v-gpu', asset_type_id: null, serials: [], vendor_id: null, status: 'planned',
    purchase_date: null, useful_life_months: 60, depreciation_convention: 'full_month', tax_method: 'book',
    tax_bonus_pct: 0, tax_life_years: null, insurance_basis: null, datacenter_contract_id: null, purchase_entry_id: null,
    disposed_on: null, disposal_proceeds: null, disposal_entry_id: null, notes: null, ...parsed.value, ...over,
  } as GpuAssetRow
  s.m.tables.gpu_assets.push({ ...row })
  return row
}
const stored = () => s.m.tables.gpu_assets[0] as GpuAssetRow
const capitalized = async () => (await listAssets(s.m.admin, 'f', 'v-gpu'))[0].capitalized_costs

describe('parseAssetInput', () => {
  it('requires name, gpu_count and hardware_cost on create, and defaults salvage to 10%', () => {
    expect(parseAssetInput({ gpu_count: 8, hardware_cost: 1 }, false)).toEqual({ error: 'name is required' })
    expect(parseAssetInput({ name: 'x', gpu_count: 0, hardware_cost: 1 }, false)).toEqual({ error: 'gpu_count must be a positive whole number' })
    expect(parseAssetInput({ name: 'x', gpu_count: 8, hardware_cost: 410_000 }, false)).toEqual({ value: { name: 'x', gpu_count: 8, hardware_cost: 410_000, salvage_value: 41_000 } })
  })

  it('takes only what an update names, and never lets a caller set disposed', () => {
    expect(parseAssetInput({ notes: 'rack 4' }, true)).toEqual({ value: { notes: 'rack 4' } })
    expect(parseAssetInput({ status: 'disposed' }, true)).toHaveProperty('error')
    expect(parseAssetInput({ tax_method: 'macrs_9' }, true)).toHaveProperty('error')
    expect(parseAssetInput({ tax_bonus_pct: 1.5 }, true)).toHaveProperty('error')
    expect(parseAssetInput({ in_service_date: '1/1/2027' }, true)).toHaveProperty('error')
    expect(parseAssetInput({ tax_method: 'bonus', tax_bonus_pct: '0.6', tax_life_years: 5 }, true)).toEqual({ value: { tax_method: 'bonus', tax_bonus_pct: 0.6, tax_life_years: 5 } })
    expect(parseAssetInput({ tax_method: 'bonus', tax_life_years: 6 }, true)).toEqual({ error: 'tax_life_years must be 5 or 7 for bonus' })
    expect(parseAssetInput({ tax_method: 'macrs_5', tax_life_years: 7 }, true)).toEqual({ error: 'tax_life_years must be 5 for macrs_5' })
    expect(parseAssetInput({ tax_method: 'straight_line', tax_life_years: 4 }, true)).toHaveProperty('value')
  })
})

describe('the asset lifecycle on the ledger', () => {
  it('provisions 1600-<a> and 1650-<a> once', async () => {
    const a = created()
    const first = await ensureAssetAccounts(s.m.admin, 'f', ctx.group, 'v-gpu', a)
    const again = await ensureAssetAccounts(s.m.admin, 'f', ctx.group, 'v-gpu', a)
    expect(again).toEqual(first)
    const codes = s.m.tables.chart_of_accounts.filter((r: any) => r.code.endsWith('-abcdef12')).map((r: any) => [r.code, r.subtype])
    expect(codes).toEqual([['1600-abcdef12', 'fixed_asset'], ['1650-abcdef12', 'accumulated_depreciation']])
  })

  it('purchase, capex, 60 months of depreciation, then disposal at book: $0 gain, asset accounts cleared', async () => {
    const a = created()
    expect(await purchaseAsset(s.m.admin, ctx, a, { entryDate: '2027-01-05', invoiced: true })).toEqual({ entryId: 'je-1' })
    expect(stored()).toMatchObject({ purchase_entry_id: 'je-1', purchase_date: '2027-01-05', status: 'ordered' })
    expect(await purchaseAsset(s.m.admin, ctx, stored(), { entryDate: '2027-01-05', invoiced: true })).toEqual({ error: 'This asset’s purchase is already booked' })

    expect(await capitalizeCost(s.m.admin, ctx, stored(), { key: 'ship-1', entryDate: '2027-01-10', amount: 2_000, invoiced: false })).toEqual({ entryId: 'je-2', capitalizedCosts: 2_000 })
    expect(await capitalizeCost(s.m.admin, ctx, stored(), { key: 'install-1', entryDate: '2027-01-12', amount: 1_000, invoiced: false })).toEqual({ entryId: 'je-3', capitalizedCosts: 3_000 })
    expect(s.m.tables.journal_entries.map((e: any) => e.source_ref)).toEqual([
      `gpu-asset:${ASSET_ID}:purchase`, `gpu-asset:${ASSET_ID}:capex:ship-1`, `gpu-asset:${ASSET_ID}:capex:install-1`,
    ])
    expect(await capitalized()).toBe(3_000)

    // What the close will post month by month (P1b-2), here directly.
    const schedule = depreciationSchedule(depreciableFromAsset(stored(), [{ month: '2027-01', amount: 3_000 }])!)
    for (const l of schedule) {
      await persistEntry(s.m.admin, 'f', ctx.group, 'u', buildDepreciationEntry({
        fundId: 'f', assetId: ASSET_ID, month: l.month, amount: l.amount, expenseAccountId: 'acc-5300', accumulatedAccountId: s.m.tables.chart_of_accounts.find((r: any) => r.code === '1650-abcdef12').id,
      }))
    }
    expect(schedule.at(-1)!.nbv).toBe(33_500)

    const result = await disposeAsset(s.m.admin, ctx, stored(), { disposedOn: '2031-12-31', proceeds: 33_500 })
    expect(result).toMatchObject({ gain: 0 })
    expect(stored()).toMatchObject({ status: 'disposed', disposed_on: '2031-12-31', disposal_proceeds: 33_500 })

    const balance = (code: string) => {
      const id = s.m.tables.chart_of_accounts.find((r: any) => r.code === code).id
      return Math.round(s.m.tables.journal_postings.filter((p: any) => p.account_id === id).reduce((t: number, p: any) => t + p.amount * 100, 0)) / 100
    }
    expect([balance('1600-abcdef12'), balance('1650-abcdef12'), balance('4500')]).toEqual([0, 0, 0])
    expect(await disposeAsset(s.m.admin, ctx, stored(), { disposedOn: '2031-12-31', proceeds: 1 })).toEqual({ error: 'This asset is already disposed of' })
  })

  const costBalance = () => {
    const id = s.m.tables.chart_of_accounts.find((r: any) => r.code === '1600-abcdef12')?.id
    return Math.round(s.m.tables.journal_postings.filter((p: any) => p.account_id === id).reduce((t: number, p: any) => t + p.amount * 100, 0)) / 100
  }
  const purchased = async () => {
    created({ status: 'in_service' })
    await purchaseAsset(s.m.admin, ctx, stored(), { entryDate: '2027-01-05', invoiced: false })
    return stored()
  }

  it('a purchase whose register update fails is linked, not rebooked, on retry', async () => {
    created()
    s.m.failNext('gpu_assets', 'update', 'canceling statement due to statement timeout')
    await expect(purchaseAsset(s.m.admin, ctx, stored(), { entryDate: '2027-01-05', invoiced: false })).rejects.toBeTruthy()
    expect(stored().purchase_entry_id).toBeNull()
    expect(await purchaseAsset(s.m.admin, ctx, stored(), { entryDate: '2027-01-05', invoiced: false })).toEqual({ entryId: 'je-1' })
    expect(s.m.tables.journal_entries).toHaveLength(1)
    expect(stored().purchase_entry_id).toBe('je-1')
  })

  it('capex that fails after the journal write books once on retry with the same key; capitalized costs equal the ledger', async () => {
    await purchased()
    s.after = () => s.m.failNext('journal_entries', 'select', 'canceling statement due to statement timeout')
    await expect(capitalizeCost(s.m.admin, ctx, stored(), { key: 'inv-77', entryDate: '2027-01-10', amount: 2_000, invoiced: false })).rejects.toBeTruthy()

    expect(await capitalizeCost(s.m.admin, ctx, stored(), { key: 'inv-77', entryDate: '2027-01-10', amount: 2_000, invoiced: false })).toEqual({ entryId: 'je-2', capitalizedCosts: 2_000 })
    expect(s.m.tables.journal_entries.filter((e: any) => e.source_ref?.includes(':capex:'))).toHaveLength(1)
    expect(await capitalized()).toBe(costBalance() - 335_000)
    expect(await capitalizeCost(s.m.admin, ctx, stored(), { key: 'inv-77', entryDate: '2027-01-10', amount: 2_500, invoiced: false })).toEqual({ error: 'Key inv-77 already capitalized 2000 on this asset' })
  })

  it('capitalized costs are read from the ledger, so interleaved capex loses nothing and a reversal takes its cost back', async () => {
    await purchased()
    let inner: unknown
    s.between = async () => { inner = await capitalizeCost(s.m.admin, ctx, stored(), { key: 'b', entryDate: '2027-01-11', amount: 1_000, invoiced: false }) }
    expect(await capitalizeCost(s.m.admin, ctx, stored(), { key: 'a', entryDate: '2027-01-10', amount: 2_000, invoiced: false })).toEqual({ entryId: 'je-2', capitalizedCosts: 3_000 })
    expect(inner).toEqual({ entryId: 'je-3', capitalizedCosts: 1_000 })
    expect(await capitalized()).toBe(3_000)
    expect(s.m.tables.gpu_assets[0]).not.toHaveProperty('capitalized_costs')

    const original = s.m.tables.journal_entries.find((e: any) => e.source_ref === `gpu-asset:${ASSET_ID}:capex:a`)
    await persistEntry(s.m.admin, 'f', ctx.group, 'u', {
      fundId: 'f', entryDate: '2027-02-01', sourceType: 'manual', sourceRef: `reversal:${original.id}`,
      postings: s.m.tables.journal_postings.filter((p: any) => p.journal_entry_id === original.id).map((p: any) => ({ accountId: p.account_id, amount: -p.amount, currency: 'USD' })),
    })
    expect(await capitalized()).toBe(1_000)
  })

  it('a request that meets another\'s draft is in progress and changes nothing (purchase, capex)', async () => {
    created({ status: 'in_service' })
    let second: unknown
    s.between = async () => { second = await purchaseAsset(s.m.admin, ctx, stored(), { entryDate: '2027-01-05', invoiced: false }) }
    s.failAfterDraft = true
    expect(await purchaseAsset(s.m.admin, ctx, stored(), { entryDate: '2027-01-05', invoiced: false })).toEqual({ error: 'posting failed' })
    expect(second).toEqual({ error: expect.stringMatching(/^Entry je-1 \(2027-01-05\) for this is still a draft/), inProgress: true })
    expect(stored().purchase_entry_id).toBeNull()
    expect(s.m.tables.journal_entries).toEqual([])

    await purchaseAsset(s.m.admin, ctx, stored(), { entryDate: '2027-01-05', invoiced: false })
    s.between = async () => { second = await capitalizeCost(s.m.admin, ctx, stored(), { key: 'k', entryDate: '2027-01-10', amount: 500, invoiced: false }) }
    expect(await capitalizeCost(s.m.admin, ctx, stored(), { key: 'k', entryDate: '2027-01-10', amount: 500, invoiced: false })).toMatchObject({ capitalizedCosts: 500 })
    expect(second).toMatchObject({ error: expect.stringContaining('is still a draft'), inProgress: true })
  })

  it('takes capex only on a purchased asset that is not disposed of', async () => {
    created()
    expect(await capitalizeCost(s.m.admin, ctx, stored(), { key: 'k', entryDate: '2027-01-10', amount: 1, invoiced: false })).toEqual({ error: 'Book the asset\u2019s purchase before capitalizing costs into it' })
    expect(await capitalizeCost(s.m.admin, ctx, { ...stored(), purchase_entry_id: 'je-x', status: 'disposed' }, { key: 'k', entryDate: '2027-01-10', amount: 1, invoiced: false })).toEqual({ error: 'A disposed asset cannot take capitalized costs' })
    expect(s.m.tables.journal_entries).toEqual([])
  })

  it('refuses a backdated disposal over later postings, but not over a later posting and its reversal', async () => {
    const a = await purchased()
    const accum = () => s.m.tables.chart_of_accounts.find((r: any) => r.code === '1650-abcdef12').id
    for (const month of ['2027-01', '2027-02']) {
      await persistEntry(s.m.admin, 'f', ctx.group, 'u', buildDepreciationEntry({ fundId: 'f', assetId: ASSET_ID, month, amount: 5_025, expenseAccountId: 'acc-5300', accumulatedAccountId: accum() }))
    }
    expect(await disposeAsset(s.m.admin, ctx, a, { disposedOn: '2027-01-31', proceeds: 300_000 })).toEqual({ error: 'This asset has postings dated after 2027-01-31. Void or reverse them, then dispose of it.' })
    expect(s.m.tables.journal_entries).toHaveLength(3)

    const feb = s.m.tables.journal_entries.find((e: any) => e.source_ref === `gpu-dep:${ASSET_ID}:2027-02`)
    await persistEntry(s.m.admin, 'f', ctx.group, 'u', {
      fundId: 'f', entryDate: '2027-03-01', sourceType: 'partnership_expense', sourceRef: `reversal:${feb.id}`,
      postings: s.m.tables.journal_postings.filter((p: any) => p.journal_entry_id === feb.id).map((p: any) => ({ accountId: p.account_id, amount: -p.amount, currency: 'USD' })),
    })
    // Only January counts: NBV 329,975, so 300,000 is a 29,975 loss.
    expect(await disposeAsset(s.m.admin, ctx, stored(), { disposedOn: '2027-01-31', proceeds: 300_000 })).toMatchObject({ gain: -29_975 })
  })

  const postDepreciation = async (months: string[], disposedOn?: string) => {
    const accum = s.m.tables.chart_of_accounts.find((r: any) => r.code === '1650-abcdef12').id
    for (const month of months) {
      await persistEntry(s.m.admin, 'f', ctx.group, 'u', buildDepreciationEntry({
        fundId: 'f', assetId: ASSET_ID, month, amount: 5_025, expenseAccountId: 'acc-5300', accumulatedAccountId: accum,
        entryDate: depreciationEntryDate(month, disposedOn),
      }))
    }
  }

  it('refuses a disposal until depreciation is posted through the disposal month, dated by the disposal', async () => {
    const a = await purchased()
    await postDepreciation(['2027-01', '2027-02'])
    expect(await disposeAsset(s.m.admin, ctx, a, { disposedOn: '2027-04-10', proceeds: 300_000 })).toEqual({ error: 'Post depreciation for 2027-03, 2027-04 before disposing of this asset.' })
    await postDepreciation(['2027-03', '2027-04'], '2027-04-10')
    expect(s.m.tables.journal_entries.at(-1).entry_date).toBe('2027-04-10')
    // Four months charged: NBV 314,900, so 300,000 is a 14,900 loss.
    expect(await disposeAsset(s.m.admin, ctx, a, { disposedOn: '2027-04-10', proceeds: 300_000 })).toMatchObject({ gain: -14_900 })
  })

  it('a reversed month counts as not posted', async () => {
    const a = await purchased()
    await postDepreciation(['2027-01'])
    const jan = s.m.tables.journal_entries.find((e: any) => e.source_ref === `gpu-dep:${ASSET_ID}:2027-01`)
    await persistEntry(s.m.admin, 'f', ctx.group, 'u', {
      fundId: 'f', entryDate: '2027-01-31', sourceType: 'partnership_expense', sourceRef: `reversal:${jan.id}`,
      postings: s.m.tables.journal_postings.filter((p: any) => p.journal_entry_id === jan.id).map((p: any) => ({ accountId: p.account_id, amount: -p.amount, currency: 'USD' })),
    })
    expect(await disposeAsset(s.m.admin, ctx, a, { disposedOn: '2027-01-31', proceeds: 1 })).toEqual({ error: 'Post depreciation for 2027-01 before disposing of this asset.' })
  })

  it('a disposal whose register update fails is adopted on retry with the committed entry\'s date, proceeds and gain', async () => {
    const a = await purchased()
    await postDepreciation(['2027-01'])
    s.m.failNext('gpu_assets', 'update', 'canceling statement due to statement timeout')
    await expect(disposeAsset(s.m.admin, ctx, a, { disposedOn: '2027-01-31', proceeds: 300_000 })).rejects.toBeTruthy()
    expect(stored().status).toBe('in_service')
    // The retry asks for different proceeds and a different date; the books say 300,000 on 2027-01-31.
    expect(await disposeAsset(s.m.admin, ctx, stored(), { disposedOn: '2027-02-15', proceeds: 310_000 })).toEqual({ entryId: 'je-3', gain: -29_975, disposedOn: '2027-01-31', proceeds: 300_000 })
    expect(s.m.tables.journal_entries.filter((e: any) => e.source_ref === `gpu-asset:${ASSET_ID}:disposal`)).toHaveLength(1)
    expect(stored()).toMatchObject({ status: 'disposed', disposal_entry_id: 'je-3', disposed_on: '2027-01-31', disposal_proceeds: 300_000 })
  })

  it('a reversed disposal is not adopted on retry', async () => {
    const a = await purchased()
    await postDepreciation(['2027-01'])
    s.m.failNext('gpu_assets', 'update', 'canceling statement due to statement timeout')
    await expect(disposeAsset(s.m.admin, ctx, a, { disposedOn: '2027-01-31', proceeds: 300_000 })).rejects.toBeTruthy()
    const disposal = s.m.tables.journal_entries.find((e: any) => e.source_ref === `gpu-asset:${ASSET_ID}:disposal`)
    await persistEntry(s.m.admin, 'f', ctx.group, 'u', {
      fundId: 'f', entryDate: '2027-02-01', sourceType: 'realized_gain', sourceRef: `reversal:${disposal.id}`,
      postings: s.m.tables.journal_postings.filter((p: any) => p.journal_entry_id === disposal.id).map((p: any) => ({ accountId: p.account_id, amount: -p.amount, currency: 'USD' })),
    })
    expect(await disposeAsset(s.m.admin, ctx, stored(), { disposedOn: '2027-01-31', proceeds: 300_000 })).toEqual({ error: expect.stringContaining('was booked and then reversed') })
    expect(stored().status).toBe('in_service')
  })

  it('a disposal that meets another\'s draft is in progress; if that one then fails, the asset is not disposed', async () => {
    const a = await purchased()
    await postDepreciation(['2027-01'])
    let second: unknown
    s.between = async () => { second = await disposeAsset(s.m.admin, ctx, stored(), { disposedOn: '2027-01-31', proceeds: 300_000 }) }
    s.failAfterDraft = true
    expect(await disposeAsset(s.m.admin, ctx, a, { disposedOn: '2027-01-31', proceeds: 300_000 })).toEqual({ error: 'posting failed' })
    expect(second).toMatchObject({ error: expect.stringContaining('is still a draft'), inProgress: true })
    expect(stored()).toMatchObject({ status: 'in_service', disposal_entry_id: null })
    expect(s.m.tables.journal_entries.some((e: any) => e.source_ref === `gpu-asset:${ASSET_ID}:disposal`)).toBe(false)

    // And when the first one completes, the second learns nothing it did not book.
    s.between = async () => { second = await disposeAsset(s.m.admin, ctx, stored(), { disposedOn: '2027-01-31', proceeds: 300_000 }) }
    expect(await disposeAsset(s.m.admin, ctx, stored(), { disposedOn: '2027-01-31', proceeds: 300_000 })).toMatchObject({ gain: -29_975 })
    expect(second).toMatchObject({ error: expect.stringContaining('is still a draft'), inProgress: true })
    expect(stored().status).toBe('disposed')
  })

  it('a reversed purchase or disposal is not adopted', async () => {
    created({ status: 'in_service' })
    s.m.failNext('gpu_assets', 'update', 'canceling statement due to statement timeout')
    await expect(purchaseAsset(s.m.admin, ctx, stored(), { entryDate: '2027-01-05', invoiced: false })).rejects.toBeTruthy()
    const reverse = async (id: string, date: string) => persistEntry(s.m.admin, 'f', ctx.group, 'u', {
      fundId: 'f', entryDate: date, sourceType: 'manual', sourceRef: `reversal:${id}`,
      postings: s.m.tables.journal_postings.filter((p: any) => p.journal_entry_id === id).map((p: any) => ({ accountId: p.account_id, amount: -p.amount, currency: 'USD' })),
    })
    await reverse('je-1', '2027-01-06')
    expect(await purchaseAsset(s.m.admin, ctx, stored(), { entryDate: '2027-01-05', invoiced: false })).toEqual({ error: expect.stringContaining('was booked and then reversed') })
    expect(stored().purchase_entry_id).toBeNull()
  })

  it('capitalized costs are found past PostgREST\'s 1,000-row cap on the chart', async () => {
    const pad = Array.from({ length: 1_100 }, (_, i) => ({ id: `acc-pad-${String(i).padStart(4, '0')}`, fund_id: 'f', vehicle_id: 'v-gpu', portfolio_group: 'H200 SPV I', code: `1600-${String(i).padStart(8, '0')}`, name: 'pad', type: 'asset', subtype: 'fixed_asset' }))
    s.m = memoryAdmin({
      fund_vehicles: [{ id: 'v-gpu', fund_id: 'f', name: 'H200 SPV I', kind: 'gpu_spv', aliases: [] }],
      chart_of_accounts: [...GPU_SPV_CHART.map(a => ({ id: `acc-${a.code}`, fund_id: 'f', vehicle_id: 'v-gpu', portfolio_group: 'H200 SPV I', code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null })), ...pad],
      gpu_assets: [], journal_entries: [], journal_postings: [],
    }, { maxRows: 1_000, unique: [{ table: 'chart_of_accounts', key: r => `${r.fund_id}|${r.portfolio_group}|${r.code}` }] })
    await purchased()
    await capitalizeCost(s.m.admin, ctx, stored(), { key: 'k', entryDate: '2027-01-10', amount: 2_000, invoiced: false })
    expect(s.m.tables.chart_of_accounts.filter((r: any) => r.code.startsWith('1600-')).length).toBeGreaterThan(1_000)
    expect(await capitalized()).toBe(2_000)
  })

  it('an asset of one entity cannot be purchased, capitalized or disposed of through another', async () => {
    const a = await purchased()
    const otherCtx = { ...ctx, group: 'H200 SPV II', vehicleId: 'v-gpu2' }
    const refusal = { error: 'This asset belongs to another entity' }
    expect(await purchaseAsset(s.m.admin, otherCtx, { ...a, purchase_entry_id: null }, { entryDate: '2027-01-05', invoiced: false })).toEqual(refusal)
    expect(await capitalizeCost(s.m.admin, otherCtx, a, { key: 'x', entryDate: '2027-01-10', amount: 1, invoiced: false })).toEqual(refusal)
    expect(await disposeAsset(s.m.admin, otherCtx, a, { disposedOn: '2027-06-30', proceeds: 1 })).toEqual(refusal)
    expect(s.m.tables.journal_entries).toHaveLength(1)
    expect(stored()).toMatchObject({ vehicle_id: 'v-gpu', status: 'in_service' })
    expect(await capitalized()).toBe(0)
  })

  it('refuses to dispose of an asset whose purchase was never booked', async () => {
    expect(await disposeAsset(s.m.admin, ctx, created(), { disposedOn: '2028-01-01', proceeds: 0 })).toHaveProperty('error')
  })
})
