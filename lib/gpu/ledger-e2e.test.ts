import { beforeAll, describe, expect, it } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { GPU_SPV_CHART, MANAGEMENT_COMPANY_CHART } from '@/lib/accounting/chart'
import { ensureCapitalAccounts, persistEntry } from '@/lib/accounting/persist'
import { closePeriodWithAllocation } from '@/lib/accounting/close'
import { loadPostedLedger } from '@/lib/accounting/load'
import { computeCapitalAccounts } from '@/lib/accounting/capital-account'
import { balanceSheet } from '@/lib/accounting/statements'
import { previewDistribution, declareDistribution } from '@/lib/accounting/distributions'
import { settleIntercompanyCharge } from '@/lib/accounting/intercompany'
import { irrOf } from '@/lib/accounting/construction-forecast'
import { ensureAssetAccounts, loadCapexEvents, loadPostedDepreciation, type Lifecycle } from './assets'
import { buildCapexEntry, buildDepreciationEntry, buildPurchaseEntry } from './entries'
import { depreciableFromAsset, depreciationEntryDate, depreciationForMonth, nbvAsOf } from './depreciation'
import { disposeAsset } from './disposal'
import { F1, PACK_INPUTS, packDistributableCash } from './fixtures/pack-v3'
import type { GpuAssetRow } from './types'

// F9 (plan §3.10): the Base case on real books, five years end to end, through the code paths a
// GPU SPV actually runs: persistEntry (with continuous allocation), the period close (fee true-up,
// no carry accrual), previewDistribution / declareDistribution (the distributable_cash waterfall
// and the realised profit share), intercompany settlement, and the fleet disposal.
//
// Depreciation is posted month by month through P1's builders (gpu-dep:<asset>:<YYYY-MM>, dated
// min(month end, disposal), amount = depreciationForMonth on the posted state), because main has no
// close-time depreciation hook yet (P1b-2b, #93). Once it lands, this switches to the suggestions
// path in one step.

const F = 'f'
const SPV = 'GPU I'
const V = 'v1'
const MC = 'mc'
const MANCO = 'ManCo'
const YEARS = [2027, 2028, 2029, 2030, 2031]
const pack = packDistributableCash('base')

const chartRows = (vehicleId: string, group: string, seeds: { code: string; name: string; type: string; subtype?: string | null }[]) =>
  seeds.map(a => ({ id: `${vehicleId}-${a.code}`, fund_id: F, vehicle_id: vehicleId, portfolio_group: group, code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null, lp_entity_id: null }))

function books() {
  return memoryAdmin({
    funds: [{ id: F, name: 'Crost' }],
    fund_settings: [{ fund_id: F, currency: 'USD' }],
    fund_vehicles: [
      { id: V, fund_id: F, name: SPV, kind: 'gpu_spv', aliases: [] },
      { id: MC, fund_id: F, name: MANCO, kind: 'manco', aliases: [] },
    ],
    chart_of_accounts: [...chartRows(V, SPV, GPU_SPV_CHART as any), ...chartRows(MC, MANCO, MANAGEMENT_COMPANY_CHART as any)],
    lp_entities: [
      { id: 'lp', fund_id: F, entity_name: 'Investor LP', partner_class: 'lp' },
      { id: 'mgr', fund_id: F, entity_name: 'Manager', partner_class: 'gp' },
    ],
    lp_investments: [{ id: 'i1', fund_id: F, portfolio_group: SPV, entity_id: 'lp', commitment: PACK_INPUTS.capital }],
    vehicle_waterfall_terms: [{
      fund_id: F, vehicle_id: V, kind: 'distributable_cash', carry_rate: 0.3, pref_rate: 0.08, catchup_rate: 1, pref_compounds: false,
      gp_entity_id: 'mgr', pref_basis: 'unreturned', pref_day_count: '30_360', roc_lp_share: 1,
    }],
    vehicle_fee_terms: [{ fund_id: F, vehicle_id: V, basis: 'gross_revenue', annual_rate: 0.05, revenue_subtypes: ['rental_revenue'], frequency: 'monthly', payee_vehicle_id: MC, effective_from: '2027-01-01', effective_to: null }],
    fiscal_periods: [], intercompany_transactions: [], distributions: [], distribution_lines: [], gpu_assets: [],
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

const ok = <T,>(r: T): Exclude<T, { error: string }> => {
  if (r && typeof r === 'object' && 'error' in (r as any)) throw new Error((r as any).error)
  return r as any
}
const leg = (accountId: string, amount: number) => ({ accountId, amount, currency: 'USD', lpEntityId: null })
const c = (n: number) => Math.round(n * 100)

interface YearEnd { year: number; check: number; unallocated: number; nbvLedger: number; nbvRegister: number }
interface Declared { year: number; available: number; tiers: any; cash: any; lpTotal: number; carryTotal: number }

const run = {
  m: null as any,
  yearEnds: [] as YearEnd[],
  declared: [] as Declared[],
  afterDisposalNbv: NaN,
}

describe('F9: the Base case on real books', () => {
  beforeAll(async () => {
    const m = books()
    run.m = m
    const admin = m.admin as any
    const ctx: Lifecycle = { fundId: F, group: SPV, vehicleId: V, userId: 'u' }
    // complete_capital_operation, as the migration defines it for a distribution: the register's lines
    // are written, its entries posted, and the row declared, together.
    admin.rpc = async (name: string, args: any) => {
      if (name === 'discard_unregistered_capital_drafts') return { data: null, error: null }
      if (name !== 'complete_capital_operation') return { data: null, error: { message: `rpc ${name} unsupported` } }
      const row = m.tables.distributions.find((d: any) => d.id === args.p_register_id)!
      for (const e of m.tables.journal_entries) if (args.p_entry_ids.includes(e.id)) Object.assign(e, { status: 'posted', posted_at: new Date().toISOString() })
      for (const l of args.p_lines) m.tables.distribution_lines.push({ id: `dl-${m.tables.distribution_lines.length}`, distribution_id: row.id, fund_id: F, vehicle_id: V, lp_entity_id: l.lpEntityId, amount: l.amount, role: l.role })
      row.status = 'declared'
      return { data: null, error: null }
    }

    const ledger = async () => {
      const { accounts, postings, capitalPostings } = await loadPostedLedger(admin, F, SPV)
      const code = (id: string) => accounts.find(a => a.id === id)?.code ?? ''
      const bal = (pred: (code: string) => boolean) => postings.filter(p => pred(code(p.accountId))).reduce((t, p) => t + c(p.amount), 0) / 100
      return { accounts, postings, capitalPostings, bal }
    }

    // Y0: the call, the three servers and their capitalized installation (10% of hardware each).
    const capital = await ensureCapitalAccounts(admin, F, SPV, ['lp', 'mgr'])
    ok(await persistEntry(admin, F, SPV, 'u', {
      fundId: F, entryDate: '2027-01-01', memo: 'Capital call', sourceType: 'capital_call',
      postings: [leg(`${V}-1000`, PACK_INPUTS.capital), { ...leg(capital.get('lp')!, -PACK_INPUTS.capital), lpEntityId: 'lp' }],
    }))
    const assets: GpuAssetRow[] = []
    for (const [id, name, cost] of [['h200', 'H200 NVL', 335_000], ['b200', 'B200', 410_000], ['b300', 'B300', 560_000]] as const) {
      const accts = await ensureAssetAccounts(admin, F, SPV, V, { id, name })
      const purchase = ok(await persistEntry(admin, F, SPV, 'u', buildPurchaseEntry({ fundId: F, entryDate: '2027-01-01', memo: `Purchase ${name}` }, { assetId: id, amount: cost, costAccountId: accts.cost, offsetAccountId: `${V}-1000` }))).entryId
      ok(await persistEntry(admin, F, SPV, 'u', buildCapexEntry({ fundId: F, entryDate: '2027-01-01', memo: `Installation ${name}` }, { assetId: id, key: 'install', amount: cost * 0.1, costAccountId: accts.cost, offsetAccountId: `${V}-1000` })))
      const row: GpuAssetRow = {
        id, fund_id: F, vehicle_id: V, asset_type_id: null, name, serials: [], vendor_id: null, status: 'in_service', gpu_count: 8,
        hardware_cost: cost, purchase_date: '2027-01-01', in_service_date: '2027-01-01', useful_life_months: 60, salvage_value: cost * 0.1,
        depreciation_convention: 'full_month', tax_method: 'book', tax_bonus_pct: 0, tax_life_years: null, insurance_basis: null,
        datacenter_contract_id: null, purchase_entry_id: purchase, disposed_on: null, disposal_proceeds: null, disposal_entry_id: null, notes: null,
      }
      m.tables.gpu_assets.push(row)
      assets.push(row)
    }
    const depreciable = async (a: GpuAssetRow) => {
      const accts = await ensureAssetAccounts(admin, F, SPV, V, a)
      return { accts, dep: depreciableFromAsset(a, await loadCapexEvents(admin, ctx, a.id, accts.cost), await loadPostedDepreciation(admin, ctx, a.id, accts.accumulated))! }
    }

    for (const [k, year] of YEARS.entries()) {
      const y = pack[k]
      const end = `${year}-12-31`
      // The year's revenue and opex, paid in cash (pack §5: datacenter and its contingency on 5100).
      ok(await persistEntry(admin, F, SPV, 'u', { fundId: F, entryDate: end, memo: 'GPU rental revenue', sourceType: 'income', postings: [leg(`${V}-1000`, y.revenue), leg(`${V}-4000`, -y.revenue)] }))
      const opex: [string, number][] = [['5100', y.datacenter + y.contingency], ['5150', y.processing], ['5200', y.insurance]]
      for (const [code, amount] of opex) {
        ok(await persistEntry(admin, F, SPV, 'u', { fundId: F, entryDate: end, memo: `Opex ${code}`, sourceType: 'partnership_expense', postings: [leg(`${V}-${code}`, amount), leg(`${V}-1000`, -amount)] }))
      }
      // Monthly depreciation, P1's convention.
      for (let mo = 1; mo <= 12; mo++) {
        const month = `${year}-${String(mo).padStart(2, '0')}`
        for (const a of assets) {
          const { accts, dep } = await depreciable(a)
          ok(await persistEntry(admin, F, SPV, 'u', buildDepreciationEntry({
            fundId: F, assetId: a.id, month, amount: depreciationForMonth(dep, month),
            expenseAccountId: `${V}-5300`, accumulatedAccountId: accts.accumulated, entryDate: depreciationEntryDate(month, a.disposed_on),
          })))
        }
      }
      // Y5: sold at book on the last day, through the fleet disposal.
      if (year === 2031) {
        for (const a of assets) {
          const { dep } = await depreciable(a)
          const out = ok(await disposeAsset(admin, ctx, a, { disposedOn: end, proceeds: nbvAsOf(dep, end) }))
          expect(out.gain).toBe(0)
          Object.assign(a, m.tables.gpu_assets.find((r: any) => r.id === a.id))
        }
      }

      ok(await closePeriodWithAllocation(admin, F, SPV, 'u', `${year}-01-01`, end, `FY${year}`))
      const l = await ledger()
      const bs = balanceSheet(l.accounts as any, l.postings as any)
      const nbvRegister = year === 2031 ? 0 : (await Promise.all(assets.map(async a => nbvAsOf((await depreciable(a)).dep, end)))).reduce((t, v) => t + c(v), 0) / 100
      run.yearEnds.push({
        // `+ 0` folds the -0 a rounded zero can come back as.
        year, check: bs.check + 0, unallocated: bs.partnersCapital.unallocatedEarnings + 0,
        nbvLedger: (c(l.bal(k => k.startsWith('1600-'))) + c(l.bal(k => k.startsWith('1650-')))) / 100, nbvRegister,
      })

      // 1 January: settle the year's fee charge, then distribute every dollar of cash.
      const date = `${year + 1}-01-01`
      for (const charge of m.tables.intercompany_transactions.filter((t: any) => t.status === 'accrued')) {
        ok(await settleIntercompanyCharge(admin, F, 'u', charge.id, date))
      }
      const available = (await ledger()).bal(k => k === '1000')
      const p = ok(await previewDistribution(admin, F, SPV, NaN, date, 'waterfall', { available, reserve: 0 }))
      ok(await declareDistribution(admin, F, SPV, 'u', {
        requestKey: `dist-${year}`, distributionDate: date, description: `FY${year} distribution`,
        lines: p.lines, carryLines: p.carryLines, splitMethod: 'waterfall', tiers: p.tiers, available: p.available, reserve: p.reserve, cash: p.cash,
      }))
      const total = (c(p.tiers.toLP) + c(p.tiers.toGP)) / 100
      // The wire: the payable settles out of cash.
      ok(await persistEntry(admin, F, SPV, 'u', { fundId: F, entryDate: date, memo: 'Distribution paid', sourceType: 'manual', postings: [leg(`${V}-2300`, total), leg(`${V}-1000`, -total)] }))
      run.declared.push({ year, available, tiers: p.tiers, cash: p.cash, lpTotal: p.tiers.toLP, carryTotal: p.tiers.toGP })
    }
    const after = await ledger()
    run.afterDisposalNbv = (c(after.bal(k => k.startsWith('1600-'))) + c(after.bal(k => k.startsWith('1650-')))) / 100
  }, 120_000)

  it("each year distributes the pack's cash, and every preview matches F1 within $1", () => {
    expect(run.declared.map(d => d.year)).toEqual(YEARS)
    run.declared.forEach((d, k) => {
      const e = F1.years[k]
      const at = `FY${d.year}`
      expect(Math.abs(d.available - e.distributable), `${at} available`).toBeLessThanOrEqual(1)
      expect(Math.abs(d.tiers.preferred - e.pref), `${at} pref`).toBeLessThanOrEqual(1)
      expect(Math.abs(d.tiers.returnOfCapital - e.roc), `${at} ROC`).toBeLessThanOrEqual(1)
      expect(Math.abs(d.tiers.profitToLP - e.profitToLP), `${at} profit`).toBeLessThanOrEqual(1)
      expect(Math.abs(d.tiers.carry - e.carry), `${at} carry`).toBeLessThanOrEqual(1)
      expect(Math.abs(d.lpTotal - e.toLP), `${at} to investors`).toBeLessThanOrEqual(1)
      expect(d.cash.prefCarriedForward).toBe(0)
    })
  })

  it('every close balances the books, leaves nothing unallocated, and ties ledger NBV to the register', () => {
    expect(run.yearEnds.map(y => y.year)).toEqual(YEARS)
    for (const y of run.yearEnds) {
      expect(y.check, `FY${y.year} balance sheet`).toBe(0)
      expect(y.unallocated, `FY${y.year} unallocated earnings`).toBe(0)
      expect(y.nbvLedger, `FY${y.year} 1600 - 1650`).toBe(y.nbvRegister)
    }
    // 1,435,500 of cost, 261,000 a year to a 130,500 salvage (per-asset cents, the last month absorbs).
    run.yearEnds.slice(0, 4).forEach((y, k) => expect(Math.abs(y.nbvLedger - (1_435_500 - 261_000 * (k + 1))), `FY${y.year} NBV`).toBeLessThanOrEqual(1))
    expect(run.afterDisposalNbv).toBe(0)
  })

  it('the fee was trued up to 5% of revenue each year, booked to the manco and settled, and no close accrued carry', () => {
    const fees = run.m.tables.intercompany_transactions.filter((t: any) => t.kind === 'management_fee' && t.status !== 'void')
    expect(fees).toHaveLength(5)
    fees.forEach((t: any, k: number) => expect(Math.abs(Number(t.amount) - F1.years[k].fee), `fee FY${YEARS[k]}`).toBeLessThanOrEqual(1))
    expect(fees.every((t: any) => t.status === 'settled' && t.to_vehicle_id === MC && t.source_ref?.startsWith('gpu-fee:'))).toBe(true)
    const closeCarry = run.m.tables.journal_entries.filter((e: any) => e.source_type === 'carried_interest' && String(e.source_ref ?? '').startsWith('close:'))
    expect(closeCarry).toEqual([])
  })

  it('after the last distribution every capital account is 0.00, and the realised profit share is the carry paid', async () => {
    const { capitalPostings } = await loadPostedLedger(run.m.admin, F, SPV)
    const accounts = computeCapitalAccounts(capitalPostings)
    expect(accounts.get('lp')!.ending).toBe(0)
    expect(accounts.get('mgr')!.ending).toBe(0)
    const sum = (type: string, lp: string) => capitalPostings.filter(p => p.sourceType === type && p.lpEntityId === lp).reduce((t, p) => t + c(p.amount), 0) / 100
    const realised = -sum('carried_interest', 'mgr')
    expect(Math.abs(realised - F1.totals.carry), 'realised profit share').toBeLessThanOrEqual(1)
    expect(sum('carry_distribution', 'mgr')).toBe(realised)
    expect(Math.abs(accounts.get('lp')!.carriedInterest + F1.totals.carry), 'investor carriedInterest').toBeLessThanOrEqual(1)
  })

  it("the investor's flows give 2.02x and IRR 33.6%", () => {
    const flows = [{ t: 0, amount: -PACK_INPUTS.capital }, ...run.declared.map((d, k) => ({ t: k + 1, amount: d.lpTotal }))]
    const total = run.declared.reduce((t, d) => t + d.lpTotal, 0)
    expect(Math.round((total / PACK_INPUTS.capital) * 100) / 100).toBe(F1.multiple)
    expect(Math.round(irrOf(flows)! * 1000) / 10).toBe(F1.irrPct)
  })
})
