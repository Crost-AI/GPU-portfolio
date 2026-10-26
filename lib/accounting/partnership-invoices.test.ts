import { describe, it, expect } from 'vitest'
import { expenseRange } from './partnership-invoices'
import { quarterBounds } from './receipts-core'

describe('expenseRange', () => {
  const q3 = quarterBounds(2026, 3)
  it('reads every earlier unbilled expense through the quarter’s end by default', () => {
    expect(expenseRange(q3)).toEqual({ from: null, through: '2026-09-30' })
  })
  it('takes the dates the person chose', () => {
    expect(expenseRange(q3, '2026-06-25', '2026-09-30')).toEqual({ from: '2026-06-25', through: '2026-09-30' })
  })
  it('refuses a start after the end, and a date that is not one', () => {
    expect(expenseRange(q3, '2026-10-01', '2026-09-30')).toHaveProperty('error')
    expect(expenseRange(q3, '2026-02-30')).toHaveProperty('error')
  })
})
