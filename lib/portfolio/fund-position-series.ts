import { computeFundPositions, type FundCapitalEvent, type FundNavStatement, type NavBasis } from './fof-metrics'

/**
 * A fund holding's position over time, for the chart on its page: cumulative contributed and
 * distributed, the manager's reported NAV on each statement date, and the multiples those imply.
 * Pure. Each point is computeFundPositions at that date, so the chart and the register's own
 * figures (carrying value rolled forward from the last statement, cost before any statement) can
 * never disagree.
 *
 * Only CONFIRMED notices count: a draft is not yet on the books.
 */

export interface RegisterEventRow {
  kind: 'call' | 'distribution'
  event_date: string
  amount: number
  status: 'draft' | 'confirmed'
  recallable_amount?: number | null
}

export interface RegisterNavRow {
  as_of_date: string
  reported_nav: number
  basis: string
}

export interface FundPositionPoint {
  date: string
  contributed: number
  distributed: number
  /** The manager's reported NAV, on a statement date only — null between statements. */
  reportedNav: number | null
  /** Reported NAV rolled forward for later cash flows (cost before the first statement). */
  carryingValue: number
  /** null while nothing has been contributed. */
  dpi: number | null
  tvpi: number | null
}

const ID = 'holding'

export function fundPositionSeries(events: RegisterEventRow[], navs: RegisterNavRow[]): FundPositionPoint[] {
  const flows: FundCapitalEvent[] = events
    .filter(e => e.status === 'confirmed' && Number.isFinite(Number(e.amount)))
    .map(e => ({
      companyId: ID, kind: e.kind, eventDate: e.event_date, amount: Math.abs(Number(e.amount)),
      recallableAmount: Number(e.recallable_amount ?? 0), charReturnOfCapital: 0, charRealizedGain: 0, charIncome: 0,
    }))
  const statements: FundNavStatement[] = navs
    .filter(n => Number.isFinite(Number(n.reported_nav)))
    .map(n => ({ companyId: ID, asOfDate: n.as_of_date, reportedNav: Number(n.reported_nav), basis: n.basis as NavBasis }))

  const dates = [...new Set([...flows.map(f => f.eventDate), ...statements.map(s => s.asOfDate)])].sort()
  const terms = [{ companyId: ID, name: '', managerName: null, vintageYear: null, strategy: null, commitment: 0 }]

  return dates.map(date => {
    const [p] = computeFundPositions({ terms, events: flows, navs: statements, asOf: date })
    const onDate = statements.filter(s => s.asOfDate === date).at(-1)
    return {
      date,
      contributed: p.contributed,
      distributed: p.distributed,
      reportedNav: onDate ? onDate.reportedNav : null,
      carryingValue: p.carryingValue,
      dpi: p.dpi,
      tvpi: p.tvpi,
    }
  })
}
