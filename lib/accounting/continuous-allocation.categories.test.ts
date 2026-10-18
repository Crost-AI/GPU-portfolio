import { describe, it, expect } from 'vitest'
import { categoryFor } from './continuous-allocation'
import { GPU_SPV_CHART } from './chart'
import type { Account } from './types'

// ── GPU fleet (P1) ── where each GPU SPV account's P&L allocates.
const acct = (code: string): Account => {
  const a = GPU_SPV_CHART.find(x => x.code === code)!
  return { id: code, fundId: 'f', code, name: a.name, type: a.type, subtype: a.subtype }
}

describe('allocation categories for the GPU SPV chart', () => {
  it('a disposal gain allocates as a realized gain', () => {
    expect(categoryFor(acct('4500'))).toBe('realized_gain')
  })

  it('rental revenue and interest allocate as income', () => {
    expect(categoryFor(acct('4000'))).toBe('income')
    expect(categoryFor(acct('4100'))).toBe('income')
  })

  it('the fee is a management fee; every operating cost is a partnership expense', () => {
    expect(categoryFor(acct('5000'))).toBe('management_fee')
    for (const code of ['5100', '5150', '5200', '5250', '5300', '5400', '5900']) {
      expect(categoryFor(acct(code)), code).toBe('partnership_expense')
    }
  })
})
