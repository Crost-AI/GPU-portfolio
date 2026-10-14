import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { periodEnd } from './period-end'

// "Latest" is the latest reporting period, then the latest import — the views' ORDER BY, played here
// over the same normalised period end the SQL computes.
type Row = { id: string; period_year: number; period_quarter: number | null; period_month: number | null; created_at: string }
const latest = (rows: Row[]) => [...rows].sort((a, b) => {
  const ea = periodEnd(a.period_year, a.period_quarter, a.period_month)
  const eb = periodEnd(b.period_year, b.period_quarter, b.period_month)
  return ea !== eb ? (ea < eb ? 1 : -1) : b.created_at.localeCompare(a.created_at)
})[0].id

describe('periodEnd', () => {
  it('ends a month at month end, a quarter at quarter end, a year at 31 December', () => {
    expect(periodEnd(2026, null, 2)).toBe('2026-02-28')
    expect(periodEnd(2024, null, 2)).toBe('2024-02-29')
    expect(periodEnd(2026, 3, null)).toBe('2026-09-30')
    expect(periodEnd(2026, 4, null)).toBe('2026-12-31')
    expect(periodEnd(2026, null, null)).toBe('2026-12-31')
  })

  it('reads a monthly row that also carries its quarter as the month', () => {
    expect(periodEnd(2026, 3, 8)).toBe('2026-08-31')
  })
})

describe('latest metric value', () => {
  it('September beats a February backfilled after it', () => {
    expect(latest([
      { id: 'sep', period_year: 2026, period_quarter: null, period_month: 9, created_at: '2026-10-01T00:00:00Z' },
      { id: 'feb', period_year: 2026, period_quarter: null, period_month: 2, created_at: '2026-10-05T00:00:00Z' },
    ])).toBe('sep')
  })

  it('Q3 (ends 30 Sep) beats August, whichever was imported last', () => {
    expect(latest([
      { id: 'q3', period_year: 2026, period_quarter: 3, period_month: null, created_at: '2026-10-01T00:00:00Z' },
      { id: 'aug', period_year: 2026, period_quarter: null, period_month: 8, created_at: '2026-10-05T00:00:00Z' },
    ])).toBe('q3')
  })

  it('the same period imported twice: the newer import wins', () => {
    expect(latest([
      { id: 'first', period_year: 2026, period_quarter: 3, period_month: null, created_at: '2026-10-01T00:00:00Z' },
      { id: 'again', period_year: 2026, period_quarter: 3, period_month: null, created_at: '2026-10-05T00:00:00Z' },
    ])).toBe('again')
  })
})

describe('metric_values_latest views', () => {
  const sql = readFileSync(path.join(process.cwd(), 'supabase/migrations/20261014180000_metric_values_latest_views.sql'), 'utf8')
    .replace(/--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase()
  const END = "(make_date(period_year, coalesce(period_month, period_quarter * 3, 12), 1) + interval '1 month' - interval '1 day')::date"

  it('compute the period end periodEnd() mirrors, and order by it, then created_at', () => {
    expect(sql.split(`${END} as period_end`)).toHaveLength(3)   // computed once in each view
    expect(sql).toContain(`select distinct on (metric_id)`)
    expect(sql).toContain(`order by metric_id, period_end desc, created_at desc`)
    expect(sql).toContain(`select distinct on (company_id)`)
    expect(sql).toContain(`order by company_id, period_end desc, created_at desc`)
  })

  it('read as the caller, so metric_values RLS still scopes them', () => {
    expect(sql.match(/with \(security_invoker = true\)/g)).toHaveLength(2)
  })
})
