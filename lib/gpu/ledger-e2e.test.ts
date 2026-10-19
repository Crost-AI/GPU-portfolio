import { describe, it, expect } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { GPU_SPV_CHART, MANAGEMENT_COMPANY_CHART } from '@/lib/accounting/chart'
import { ensureCapitalAccounts, persistEntry } from '@/lib/accounting/persist'
import { closePeriodWithAllocation } from '@/lib/accounting/close'
import { loadPostedLedger } from '@/lib/accounting/load'
import { ensureAssetAccounts, loadCapexEvents, loadPostedDepreciation, type Lifecycle } from './assets'
import { buildCapexEntry, buildDepreciationEntry, buildPurchaseEntry } from './entries'
import { depreciableFromAsset, depreciationEntryDate, depreciationForMonth } from './depreciation'
import { packDistributableCash } from './fixtures/pack-v3'
import type { GpuAssetRow } from './types'

const F = 'f'
const SPV = 'GPU I'
const V = 'v1'
const MC = 'mc'
const chartRows = (vehicleId: string, group: string, seeds: { code: string; name: string; type: string; subtype?: string | null }[]) =>
  seeds.map(a => ({ id: `${vehicleId}-${a.code}`, fund_id: F, vehicle_id: vehicleId, portfolio_group: group, code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null, lp_entity_id: null }))

function books() {
  return memoryAdmin({
    funds: [{ id: F, name: 'Crost' }],
    fund_settings: [{ fund_id: F, currency: 'USD' }],
    fund_vehicles: [
      { id: V, fund_id: F, name: SPV, kind: 'gpu_spv', aliases: [] },
      { id: MC, fund_id: F, name: 'ManCo', kind: 'manco', aliases: [] },
    ],
    chart_of_accounts: [...chartRows(V, SPV, GPU_SPV_CHART as any), ...chartRows(MC, 'ManCo', MANAGEMENT_COMPANY_CHART as any)],
    lp_entities: [
      { id: 'lp', fund_id: F, entity_name: 'Investor LP', partner_class: 'lp' },
      { id: 'mgr', fund_id: F, entity_name: 'Manager', partner_class: 'gp' },
    ],
    lp_investments: [{ id: 'i1', fund_id: F, portfolio_group: SPV, entity_id: 'lp', commitment: 1_435_500 }],
    vehicle_waterfall_terms: [{
      fund_id: F, vehicle_id: V, kind: 'distributable_cash', carry_rate: 0.3, pref_rate: 0.08, catchup_rate: 1, pref_compounds: false,
      gp_entity_id: 'mgr', pref_basis: 'unreturned', pref_day_count: '30_360', roc_lp_share: 1,
    }],
    vehicle_fee_terms: [{ fund_id: F, vehicle_id: V, basis: 'gross_revenue', annual_rate: 0.05, revenue_subtypes: ['rental_revenue'], frequency: 'monthly', payee_vehicle_id: MC, effective_from: '2027-01-01', effective_to: null }],
    fiscal_periods: [], intercompany_transactions: [], distributions: [], gpu_assets: [],
  }, {
    // The chart's unique key, so ensureAssetAccounts' upsert finds the accounts it made before.
    unique: [{ table: 'chart_of_accounts', key: r => `${r.fund_id}|${r.portfolio_group}|${r.code}` }],
    // The database's column defaults, which memoryAdmin does not apply: postings land on the actual book.
    before: (table, op, payload) => {
      if (op !== 'insert' || (table !== 'journal_postings' && table !== 'journal_entries')) return
      for (const row of Array.isArray(payload) ? payload : [payload]) row.book ??= 'actual'
    },
  })
}

const posted = (r: any) => { if ('error' in r) throw new Error(r.error); return r.entryId as string }
const leg = (accountId: string, amount: number) => ({ accountId, amount, currency: 'USD', lpEntityId: null })

describe('F9 spike', () => {
  it('year one closes', async () => {
    const m = books()
    const admin = m.admin as any
    const ctx: Lifecycle = { fundId: F, group: SPV, vehicleId: V, userId: 'u' }
    const cap = await ensureCapitalAccounts(admin, F, SPV, ['lp', 'mgr'])
    posted(await persistEntry(admin, F, SPV, 'u', {
      fundId: F, entryDate: '2027-01-01', memo: 'Capital call', sourceType: 'capital_call',
      postings: [leg(`${V}-1000`, 1_435_500), { ...leg(cap.get('lp')!, -1_435_500), lpEntityId: 'lp' }],
    }))
    const hw = [['h200', 'H200 NVL', 335_000], ['b200', 'B200', 410_000], ['b300', 'B300', 560_000]] as const
    const assets: GpuAssetRow[] = []
    for (const [id, name, cost] of hw) {
      const accts = await ensureAssetAccounts(admin, F, SPV, V, { id, name })
      const p = posted(await persistEntry(admin, F, SPV, 'u', buildPurchaseEntry({ fundId: F, entryDate: '2027-01-01', memo: `Purchase ${name}` }, { assetId: id, amount: cost, costAccountId: accts.cost, offsetAccountId: `${V}-1000` })))
      posted(await persistEntry(admin, F, SPV, 'u', buildCapexEntry({ fundId: F, entryDate: '2027-01-01', memo: `Install ${name}` }, { assetId: id, key: 'install', amount: cost * 0.1, costAccountId: accts.cost, offsetAccountId: `${V}-1000` })))
      const row: GpuAssetRow = {
        id, fund_id: F, vehicle_id: V, asset_type_id: null, name, serials: [], vendor_id: null, status: 'in_service', gpu_count: 8,
        hardware_cost: cost, purchase_date: '2027-01-01', in_service_date: '2027-01-01', useful_life_months: 60, salvage_value: cost * 0.1,
        depreciation_convention: 'full_month', tax_method: 'book', tax_bonus_pct: 0, tax_life_years: null, insurance_basis: null,
        datacenter_contract_id: null, purchase_entry_id: p, disposed_on: null, disposal_proceeds: null, disposal_entry_id: null, notes: null,
      }
      m.tables.gpu_assets.push(row)
      assets.push(row)
    }
    const y = packDistributableCash('base')[0]
    posted(await persistEntry(admin, F, SPV, 'u', { fundId: F, entryDate: '2027-12-31', memo: 'Rental revenue', sourceType: 'income', postings: [leg(`${V}-1000`, y.revenue), leg(`${V}-4000`, -y.revenue)] }))
    for (const month of Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, '0')}`)) {
      for (const a of assets) {
        const accts = await ensureAssetAccounts(admin, F, SPV, V, a)
        const dep = depreciableFromAsset(a, await loadCapexEvents(admin, ctx, a.id, accts.cost), await loadPostedDepreciation(admin, ctx, a.id, accts.accumulated))!
        posted(await persistEntry(admin, F, SPV, 'u', buildDepreciationEntry({ fundId: F, assetId: a.id, month, amount: depreciationForMonth(dep, month), expenseAccountId: `${V}-5300`, accumulatedAccountId: accts.accumulated, entryDate: depreciationEntryDate(month) })))
      }
    }
    const close = await closePeriodWithAllocation(admin, F, SPV, 'u', '2027-01-01', '2027-12-31', 'FY2027')
    console.log(JSON.stringify(close).slice(0, 500))
    const { accounts, postings } = await loadPostedLedger(admin, F, SPV)
    const bal = (code: string) => Math.round(postings.filter(p => accounts.find(a => a.id === p.accountId)?.code === code).reduce((t, p) => t + p.amount, 0) * 100) / 100
    console.log({ cash: bal('1000'), rev: bal('4000'), fee: bal('5000'), dep: bal('5300'), bridge: bal('3200'), tables: Object.keys(m.tables) })
    expect(close).not.toHaveProperty('error')
  })
})
