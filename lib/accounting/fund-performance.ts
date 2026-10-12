// The fund performance report: the LP-only cash flows of one vehicle through a date, and the
// returns they imply — the Carta-style page a GP sends with a quarter's statements.
//
// NOTHING HERE IS TYPED IN. Contributions and distributions are the LP-class partners' own
// capital-account postings, the NAV is their ending capital, and every ratio comes from
// `vehicleEconomics` (fund-economics.ts) — the same figures the fund overview shows. This file
// only arranges them into rows. That matters because the report it replaces was assembled by
// hand, and its ratios disagreed with each other (a TVPI that was not DPI + RVPI).
//
// The rows can be grouped by month or quarter for reading, but the IRR is always computed on the
// exact dates — grouping is presentation, never an input to the return.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from './ledger'
import { vehicleEconomics, type FundMetrics, type LpDatedFlow } from './fund-economics'
import { periodLabel, type FundPerformanceReport, type PerformanceGrouping, type PerformanceRow } from './fund-performance-format'

export { lastQuarterEnd, periodLabel, PERFORMANCE_GROUPINGS } from './fund-performance-format'
export type { FundPerformanceReport, PerformanceGrouping, PerformanceRow } from './fund-performance-format'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


function groupKey(date: string, grouping: PerformanceGrouping): { key: string; label: string } {
  if (grouping === 'date') return { key: date, label: date }
  const [y, m] = date.split('-').map(Number)
  if (grouping === 'month') return { key: date.slice(0, 7), label: `${MONTHS[m - 1]} ${y}` }
  const q = Math.floor((m - 1) / 3) + 1
  return { key: `${y}-Q${q}`, label: `Q${q} ${y}` }
}

/** Pure: arrange the LP flows and metrics into the report. */
export function buildFundPerformance(input: {
  vehicle: string
  asOf: string
  grouping: PerformanceGrouping
  lp: FundMetrics
  flows: LpDatedFlow[]
}): FundPerformanceReport {
  const { vehicle, asOf, grouping, lp } = input
  const flows = input.flows.filter(f => f.date <= asOf)

  const groups = new Map<string, PerformanceRow>()
  for (const f of flows) {
    const { key, label } = groupKey(f.date, grouping)
    const row = groups.get(key) ?? { label, date: f.date, contributions: 0, distributions: 0, net: 0 }
    row.contributions += f.contributions
    row.distributions += f.distributions
    if (f.date > row.date) row.date = f.date
    groups.set(key, row)
  }
  const rows = Array.from(groups.values())
    .map(r => ({
      ...r,
      contributions: roundCents(r.contributions),
      distributions: roundCents(r.distributions),
      net: roundCents(r.distributions - r.contributions),
    }))
    // A call refunded inside the same month nets to nothing; a row of dashes says nothing.
    .filter(r => r.contributions !== 0 || r.distributions !== 0)
    .sort((a, b) => a.date.localeCompare(b.date))

  const contributions = roundCents(rows.reduce((s, r) => s + r.contributions, 0))
  const distributions = roundCents(rows.reduce((s, r) => s + r.distributions, 0))
  const nav = lp.nav ?? 0

  const notes: string[] = []
  // The rows and the summary come from the same postings, so they agree on clean books. Where a
  // partner's capital is taken from a reported statement instead of dated entries, they cannot.
  const off = (a: number | null, b: number) => a != null && Math.abs(a - b) >= 0.01
  if (off(lp.paidIn, contributions) || off(lp.distributions, distributions)) {
    notes.push(
      'Some partners’ capital comes from reported statements rather than dated ledger entries, so the dated rows do not add up to the totals below.',
    )
  }
  if (lp.paidIn == null || lp.distributions == null || lp.nav == null) {
    notes.push('Some partners have no supported capital figures yet, so the totals are incomplete.')
  }
  if (lp.irr == null && (lp.paidIn ?? 0) > 0) {
    notes.push('The IRR is not shown: it needs every partner’s capital to come from dated ledger entries.')
  }

  return {
    vehicle,
    asOf,
    periodLabel: periodLabel(asOf),
    grouping,
    rows,
    totals: { contributions, distributions, nav, net: roundCents(distributions - contributions + nav) },
    metrics: {
      committed: lp.committed,
      contributions: lp.paidIn,
      distributions: lp.distributions,
      nav: lp.nav,
      totalValue: lp.totalValue,
      irr: lp.irr,
      tvpi: lp.tvpi,
      dpi: lp.dpi,
      rvpi: lp.rvpi,
    },
    notes,
  }
}

/** Load one vehicle's LP-only economics through `asOf` and build the report. */
export async function fundPerformance(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf: string,
  grouping: PerformanceGrouping,
): Promise<FundPerformanceReport> {
  const economics = await vehicleEconomics(admin, fundId, group, asOf, undefined, { lpFlows: true })
  return buildFundPerformance({ vehicle: group, asOf, grouping, lp: economics.lp, flows: economics.lpFlows ?? [] })
}
