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
//
// Options, for the cross-year cases:
//   - catchUpDecember: A's December 2027 charge is posted on 5 January 2028 (the close catching up),
//     still under its gpu-dep:<A>:2027-12 ref, so it is 2028 expense.
//   - year2028: A depreciates through 2028 and the close allocates it; with `sellA`, A is sold on
//     30 September 2028 for 70,000 (book 31,500 accumulated, so a book gain of 1,500).

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

/** Posts actual-book entries into a fixture's tables; `allocate` books a P&L amount to the partners 60/40, as the close does. */
export function ledgerWriter(t: { journal_entries: Row[]; journal_postings: Row[] }) {
  const je = (source_type: string, entry_date: string, source_ref: string | null, lines: [string, number, string?][]) => {
    const id = `je-${t.journal_entries.length + 1}`
    t.journal_entries.push({ id, fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', status: 'posted', entry_date, source_type, source_ref })
    for (const [account_id, amount, lp] of lines) {
      t.journal_postings.push({ id: `jp-${t.journal_postings.length + 1}`, journal_entry_id: id, fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', account_id, amount, lp_entity_id: lp ?? null })
    }
    return id
  }
  const allocate = (source_type: string, date: string, amount: number) =>
    // Debit-positive P&L effect on capital: an expense debits it, income credits it.
    je(source_type, date, `allocation:${source_type}:${date}`, [['cap-a', amount * 0.6, 'lp-a'], ['cap-b', amount * 0.4, 'lp-b'], ['g-3200', -amount]])
  return { je, allocate }
}

const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)

export function gpuTaxYear(opts: { catchUpDecember?: boolean; year2028?: { sellA?: boolean } } = {}): Record<string, Row[]> {
  const entries: Row[] = []
  const postings: Row[] = []
  const { je, allocate } = ledgerWriter({ journal_entries: entries, journal_postings: postings })
  const dep = (id: string, month: string, date: string) => je('depreciation', date, `gpu-dep:${id}:${month}`, [['g-5300', 1_500], [`1650-${id.slice(0, 8)}`, -1_500]])

  je('capital_call', '2027-01-10', null, [['g-1000', 200_000], ['cap-a', -120_000, 'lp-a'], ['cap-b', -80_000, 'lp-b']])
  for (const id of [A, B]) je('manual', '2027-01-15', `gpu-asset:${id}:purchase`, [[`1600-${id.slice(0, 8)}`, 100_000], ['g-1000', -100_000]])
  for (let m = 1; m <= 12; m++) {
    const month = `2027-${String(m).padStart(2, '0')}`
    for (const id of m <= 9 ? [A, B] : [A]) dep(id, month, opts.catchUpDecember && id === A && m === 12 ? '2028-01-05' : monthEnd(2027, m))
  }
  je('manual', '2027-09-30', `gpu-asset:${B}:disposal`, [['g-1000', 90_000], [`1650-${B.slice(0, 8)}`, 13_500], [`1600-${B.slice(0, 8)}`, -100_000], ['g-4500', -3_500]])
  je('income', '2027-12-31', null, [['g-1000', 60_000], ['g-4000', -60_000]])
  je('partnership_expense', '2027-12-31', null, [['g-5100', 6_000], ['g-5200', 1_000], ['g-5250', 500], ['g-1000', -7_500]])
  allocate('income', '2027-12-31', -60_000)
  allocate('realized_gain', '2027-12-31', -3_500)
  allocate('partnership_expense', '2027-12-31', 31_500 + 7_500 - (opts.catchUpDecember ? 1_500 : 0))

  const sellA = !!opts.year2028?.sellA
  if (opts.year2028) {
    const months = sellA ? 9 : 12
    for (let m = 1; m <= months; m++) dep(A, `2028-${String(m).padStart(2, '0')}`, monthEnd(2028, m))
    if (sellA) {
      je('manual', '2028-09-30', `gpu-asset:${A}:disposal`, [['g-1000', 70_000], [`1650-${A.slice(0, 8)}`, 31_500], [`1600-${A.slice(0, 8)}`, -100_000], ['g-4500', -1_500]])
      allocate('realized_gain', '2028-12-31', -1_500)
    }
    allocate('partnership_expense', '2028-12-31', months * 1_500 + (opts.catchUpDecember ? 1_500 : 0))
  }

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
    gpu_assets: [
      asset(A, 'H200 #1', sellA ? { status: 'disposed', disposed_on: '2028-09-30' } : {}),
      asset(B, 'H200 #2', { status: 'disposed', disposed_on: '2027-09-30' }),
    ],
    journal_entries: entries,
    journal_postings: postings,
    distributions: [],
    lp_investments: [],
  }
}
