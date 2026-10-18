import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import type { JournalEntry } from '@/lib/accounting/types'

// persistEntry stands in for the ledger: it refuses a repeated source_ref and writes the entry as
// posted rows, so the disposal reads back exactly what the purchase and depreciation booked.
const s = vi.hoisted(() => ({ m: null as any }))
vi.mock('@/lib/accounting/persist', () => ({
  persistEntry: vi.fn(async (_a: any, fundId: string, _g: string, _u: string, entry: JournalEntry) => {
    const t = s.m.tables
    if (entry.sourceRef && t.journal_entries.some((e: any) => e.source_ref === entry.sourceRef)) return { error: 'duplicate' }
    const id = `je-${t.journal_entries.length + 1}`
    t.journal_entries.push({ id, fund_id: fundId, vehicle_id: 'v-gpu', book: 'actual', status: 'posted', entry_date: entry.entryDate, source_type: entry.sourceType, source_ref: entry.sourceRef, memo: entry.memo })
    for (const p of entry.postings) t.journal_postings.push({ id: `jp-${t.journal_postings.length + 1}`, journal_entry_id: id, fund_id: fundId, vehicle_id: 'v-gpu', book: 'actual', account_id: p.accountId, amount: p.amount, currency: 'USD', lp_entity_id: null })
    return { entryId: id }
  }),
}))

import { capitalizeCost, ensureAssetAccounts, parseAssetInput, purchaseAsset } from './assets'
import { disposeAsset } from './disposal'
import { buildDepreciationEntry } from './entries'
import { depreciableFromAsset, depreciationSchedule } from './depreciation'
import { persistEntry } from '@/lib/accounting/persist'
import { GPU_SPV_CHART } from '@/lib/accounting/chart'
import type { GpuAssetRow } from './types'

const ASSET_ID = 'abcdef12-0000-4000-8000-000000000001'
const ctx = { fundId: 'f', group: 'H200 SPV I', vehicleId: 'v-gpu', userId: 'u' }

beforeEach(() => {
  s.m = memoryAdmin({
    fund_vehicles: [{ id: 'v-gpu', fund_id: 'f', name: 'H200 SPV I', kind: 'gpu_spv', aliases: [] }],
    chart_of_accounts: GPU_SPV_CHART.map(a => ({ id: `acc-${a.code}`, fund_id: 'f', vehicle_id: 'v-gpu', portfolio_group: 'H200 SPV I', code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null })),
    gpu_assets: [], journal_entries: [], journal_postings: [],
  }, { unique: [{ table: 'chart_of_accounts', key: r => `${r.fund_id}|${r.portfolio_group}|${r.code}` }] })
})

const created = (over: Partial<GpuAssetRow> = {}): GpuAssetRow => {
  const parsed = parseAssetInput({ name: 'H200 #1', gpu_count: 8, hardware_cost: 335_000, in_service_date: '2027-01-15' }, false)
  if ('error' in parsed) throw new Error(parsed.error)
  const row = {
    id: ASSET_ID, fund_id: 'f', vehicle_id: 'v-gpu', asset_type_id: null, serials: [], vendor_id: null, status: 'planned',
    capitalized_costs: 0, purchase_date: null, useful_life_months: 60, depreciation_convention: 'full_month', tax_method: 'book',
    tax_bonus_pct: 0, tax_life_years: null, insurance_basis: null, datacenter_contract_id: null, purchase_entry_id: null,
    disposed_on: null, disposal_proceeds: null, disposal_entry_id: null, notes: null, ...parsed.value, ...over,
  } as GpuAssetRow
  s.m.tables.gpu_assets.push({ ...row })
  return row
}
const stored = () => s.m.tables.gpu_assets[0] as GpuAssetRow

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

    expect(await capitalizeCost(s.m.admin, ctx, stored(), { entryDate: '2027-01-10', amount: 2_000, invoiced: false })).toEqual({ entryId: 'je-2' })
    expect(await capitalizeCost(s.m.admin, ctx, stored(), { entryDate: '2027-01-12', amount: 1_000, invoiced: false })).toEqual({ entryId: 'je-3' })
    expect(s.m.tables.journal_entries.map((e: any) => e.source_ref)).toEqual([
      `gpu-asset:${ASSET_ID}:purchase`, `gpu-asset:${ASSET_ID}:capex:1`, `gpu-asset:${ASSET_ID}:capex:2`,
    ])
    expect(stored().capitalized_costs).toBe(3_000)

    // What the close will post month by month (P1b-2), here directly.
    const schedule = depreciationSchedule(depreciableFromAsset(stored())!)
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

  it('refuses to dispose of an asset whose purchase was never booked', async () => {
    expect(await disposeAsset(s.m.admin, ctx, created(), { disposedOn: '2028-01-01', proceeds: 0 })).toHaveProperty('error')
  })
})
