import { describe, expect, it } from 'vitest'
import { parseMetricPeriod } from './period'

describe('parseMetricPeriod', () => {
  it('reads quarters either way round', () => {
    expect(parseMetricPeriod('Q3 2026')).toEqual({ label: 'Q3 2026', year: 2026, quarter: 3 })
    expect(parseMetricPeriod('2026-Q1')).toEqual({ label: 'Q1 2026', year: 2026, quarter: 1 })
  })

  it('reads months by number or name', () => {
    expect(parseMetricPeriod('2026-09')).toEqual({ label: 'Sep 2026', year: 2026, month: 9 })
    expect(parseMetricPeriod('September 2026')).toEqual({ label: 'Sep 2026', year: 2026, month: 9 })
    expect(parseMetricPeriod('sep 2026')).toEqual({ label: 'Sep 2026', year: 2026, month: 9 })
  })

  it('reads years and fiscal years', () => {
    expect(parseMetricPeriod('FY2025')).toEqual({ label: 'FY2025', year: 2025 })
    expect(parseMetricPeriod('2025')).toEqual({ label: '2025', year: 2025 })
  })

  it('refuses what it cannot read rather than guessing', () => {
    for (const bad of ['', 'Q5 2026', '2026-13', "Q3 '26", 'last quarter', 'Smarch 2026', '1850']) {
      expect(parseMetricPeriod(bad), bad).toBeNull()
    }
  })
})
