import { describe, expect, it } from 'vitest'
import { cashFlowForecastState } from './chart-visibility'

const detail = (id: string, sources: string[]) => ({ plan: { id }, entries: sources.map(source => ({ source })) })

describe('cashFlowForecastState', () => {
  it('is unknown until the plan list loads', () => {
    expect(cashFlowForecastState(null, '', null)).toBe('unknown')
  })
  it('is none with no plans', () => {
    expect(cashFlowForecastState([], '', null)).toBe('none')
  })
  it('is unknown while the selected plan loads', () => {
    expect(cashFlowForecastState([{}], 'a', null)).toBe('unknown')
    expect(cashFlowForecastState([{}], 'a', detail('b', ['rule']))).toBe('unknown')
  })
  it('is none for a plan with no entries, or only opening settlements', () => {
    expect(cashFlowForecastState([{}], 'a', detail('a', []))).toBe('none')
    expect(cashFlowForecastState([{}], 'a', detail('a', ['opening', 'opening']))).toBe('none')
  })
  it('is present once the plan forecasts anything of its own', () => {
    expect(cashFlowForecastState([{}], 'a', detail('a', ['opening', 'construction']))).toBe('present')
    expect(cashFlowForecastState([{}], 'a', detail('a', ['rule']))).toBe('present')
    expect(cashFlowForecastState([{}], 'a', detail('a', ['manual']))).toBe('present')
  })
})
