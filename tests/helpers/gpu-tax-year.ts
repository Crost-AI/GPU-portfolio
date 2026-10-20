// ── GPU fleet (P1c) ── One tax year of a GPU SPV, as the actual book holds it after the close, for
// the tax tests (gpu-tax-depreciation.test.ts, gpu-tax-acceptance.test.ts). Two servers, both bought
// and placed in service in January 2027 at 100,000 (salvage 10,000, 60 months, so 1,500 a month on
// the books) with 5-year MACRS for tax:
//
//   - A is held all year: book 18,000, tax 20,000 (MACRS year 1, 20%).
//   - B is sold on 30 September for 90,000: book 13,500 (nine months), tax nil (disposed of in the
//     year placed in service, half-year convention), so a book gain of 3,500 is a tax loss of 10,000.
//
// Rental revenue 60,000; datacenter 6,000, insurance (5200) 1,000, repairs (5250) 500. The close
// allocated income, the gain and the expenses 60/40 to two partners.

import { GPU_SPV_CHART } from '@/lib/accounting/chart'
import type { Row } from './memory-admin'

export const A = 'aaaaaaaa-0000-4000-8000-000000000001'
export const B = 'bbbbbbbb-0000-4000-8000-000000000002'
export const GROUP = 'H200 SPV I'

const asset = (id: string, name: string, over: Row = {}): Row => ({
  id, fund_id: 'f', vehicle_id: 'v-gpu', name, status: 'in_service', gpu_count: 8,
  hardware_cost: 100_000, salvage_value: 10_000, useful_life_months: 60, in_service_date: '2027-01-15',
  depreciation_convention: 'full_month', tax_method: 'macrs_5', tax_bonus_pct: 0, tax_life_years: null,
  disposed_on: null, created_at: `2027-01-01T00:00:0${id === A ? 1 : 2}Z`, ...over,
})

export function gpuTaxYear(): Record<string, Row[]> {
  const entries: Row[] = []
  const postings: Row[] = []
  const je = (source_type: string, entry_date: string, source_ref: string | null, lines: [string, number, string?][]) => {
    const id = `je-${entries.length + 1}`
    entries.push({ id, fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', status: 'posted', entry_date, source_type, source_ref })
    for (const [account_id, amount, lp] of lines) {
      postings.push({ id: `jp-${postings.length + 1}`, journal_entry_id: id, fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', account_id, amount, lp_entity_id: lp ?? null })
    }
  }
  const allocate = (source_type: string, date: string, amount: number) =>
    // Debit-positive P&L effect on capital: an expense debits it, income credits it.
    je(source_type, date, `allocation:${source_type}:${date}`, [['cap-a', amount * 0.6, 'lp-a'], ['cap-b', amount * 0.4, 'lp-b'], ['g-3200', -amount]])

  je('capital_call', '2027-01-10', null, [['g-1000', 200_000], ['cap-a', -120_000, 'lp-a'], ['cap-b', -80_000, 'lp-b']])
  for (const id of [A, B]) je('manual', '2027-01-15', `gpu-asset:${id}:purchase`, [[`1600-${id.slice(0, 8)}`, 100_000], ['g-1000', -100_000]])
  for (let m = 1; m <= 12; m++) {
    const month = `2027-${String(m).padStart(2, '0')}`
    const end = new Date(Date.UTC(2027, m, 0)).toISOString().slice(0, 10)
    for (const id of m <= 9 ? [A, B] : [A]) je('depreciation', end, `gpu-dep:${id}:${month}`, [['g-5300', 1_500], [`1650-${id.slice(0, 8)}`, -1_500]])
  }
  je('manual', '2027-09-30', `gpu-asset:${B}:disposal`, [['g-1000', 90_000], [`1650-${B.slice(0, 8)}`, 13_500], [`1600-${B.slice(0, 8)}`, -100_000], ['g-4500', -3_500]])
  je('income', '2027-12-31', null, [['g-1000', 60_000], ['g-4000', -60_000]])
  je('partnership_expense', '2027-12-31', null, [['g-5100', 6_000], ['g-5200', 1_000], ['g-5250', 500], ['g-1000', -7_500]])
  allocate('income', '2027-12-31', -60_000)
  allocate('realized_gain', '2027-12-31', -3_500)
  allocate('partnership_expense', '2027-12-31', 31_500 + 7_500)

  const account = (code: string, name: string, type: string, subtype: string | null, lp: string | null = null, id = code) =>
    ({ id, fund_id: 'f', vehicle_id: 'v-gpu', portfolio_group: GROUP, code, name, type, subtype, lp_entity_id: lp })
  return {
    fund_vehicles: [{ id: 'v-gpu', fund_id: 'f', name: GROUP, kind: 'gpu_spv', aliases: [] }],
    fund_settings: [{ fund_id: 'f', currency: 'USD' }],
    lp_entities: [{ id: 'lp-a', fund_id: 'f', entity_name: 'A' }, { id: 'lp-b', fund_id: 'f', entity_name: 'B' }],
    chart_of_accounts: [
      ...GPU_SPV_CHART.map(a => account(a.code, a.name, a.type, a.subtype ?? null, null, `g-${a.code}`)),
      ...[A, B].flatMap(id => [
        account(`1600-${id.slice(0, 8)}`, 'GPU equipment', 'asset', 'fixed_asset'),
        account(`1650-${id.slice(0, 8)}`, 'Accumulated depreciation', 'asset', 'accumulated_depreciation'),
      ]),
      account('3100-a', "Partners' capital — A", 'equity', 'lp_capital', 'lp-a', 'cap-a'),
      account('3100-b', "Partners' capital — B", 'equity', 'lp_capital', 'lp-b', 'cap-b'),
    ],
    gpu_assets: [asset(A, 'H200 #1'), asset(B, 'H200 #2', { status: 'disposed', disposed_on: '2027-09-30' })],
    journal_entries: entries,
    journal_postings: postings,
    distributions: [],
    lp_investments: [],
  }
}
