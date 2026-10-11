import { describe, expect, it } from 'vitest'
import { capitalUsage } from './capital-usage'

const base = {
  committedCapital: 100, calledCapital: 0, deployedTotal: 0, plannedCost: 0,
  feesIncurred: 0, feesProjected: 0, orgCostsIncurred: 0, orgCostsProjected: 0, expensesIncurred: 0, expensesProjected: 0,
}
const slots = (u: ReturnType<typeof capitalUsage>) =>
  u.deployed + u.planned + u.feesActual + u.feesForecast + u.expensesActual + u.expensesForecast + u.unallocated + u.calledUnallocated + u.uncalledUnallocated

describe('capitalUsage', () => {
  it('splits the leftover into called and uncalled, summing to committed', () => {
    // 40 called; 30 invested + 5 fees paid; 20 planned + 5 fees to come. Leftover 40.
    const u = capitalUsage({ ...base, calledCapital: 40, deployedTotal: 30, feesIncurred: 5, plannedCost: 20, feesProjected: 5 }, { calledKnown: true })
    // Uses (60) exceed calls (40): nothing called is left over.
    expect(u.calledUnallocated).toBe(0)
    expect(u.uncalledUnallocated).toBe(40)
    expect(u.uncalled).toBe(60)
    expect(slots(u)).toBe(100)
  })

  it('shows called cash beyond every use as called-but-unallocated', () => {
    // 80 called; 30 invested, 10 planned, 5 + 5 fees. Uses 50, leftover 50: 30 called, 20 uncalled.
    const u = capitalUsage({ ...base, calledCapital: 80, deployedTotal: 30, plannedCost: 10, feesIncurred: 5, feesProjected: 5 }, { calledKnown: true })
    expect(u.calledUnallocated).toBe(30)
    expect(u.uncalledUnallocated).toBe(20)
    expect(u.uncalledUnallocated).toBe(u.uncalled)
    expect(slots(u)).toBe(100)
  })

  it('handles calls short of what has already been paid', () => {
    const u = capitalUsage({ ...base, calledCapital: 10, deployedTotal: 30 }, { calledKnown: true })
    expect(u.calledUnallocated).toBe(0)
    expect(u.uncalledUnallocated).toBe(70)
    expect(slots(u)).toBe(100)
  })

  it('a fully called fund with nothing used is all called-but-unallocated', () => {
    const u = capitalUsage({ ...base, calledCapital: 100 }, { calledKnown: true })
    expect(u.calledUnallocated).toBe(100)
    expect(u.uncalledUnallocated).toBe(0)
    expect(u.uncalled).toBe(0)
  })

  it('clamps calls above the commitment and negative inputs', () => {
    const u = capitalUsage({ ...base, calledCapital: 150, deployedTotal: -5, feesProjected: Number.NaN }, { calledKnown: true })
    expect(u.called).toBe(100)
    expect(u.deployed).toBe(0)
    expect(u.feesForecast).toBe(0)
    expect(u.calledUnallocated).toBe(100)
    expect(slots(u)).toBe(100)
  })

  it('leaves nothing over when the plan overruns the commitment', () => {
    const u = capitalUsage({ ...base, calledCapital: 50, deployedTotal: 60, plannedCost: 60 }, { calledKnown: true })
    expect(u.calledUnallocated).toBe(0)
    expect(u.uncalledUnallocated).toBe(0)
    expect(u.unallocated).toBe(0)
  })

  it('keeps one unallocated slot when the called figure is unknown', () => {
    const u = capitalUsage({ ...base, deployedTotal: 30 }, { calledKnown: false })
    expect(u.unallocated).toBe(70)
    expect(u.calledUnallocated).toBe(0)
    expect(u.uncalledUnallocated).toBe(0)
    expect(slots(u)).toBe(100)
  })

  it('handles a zero commitment', () => {
    const u = capitalUsage({ ...base, committedCapital: 0, calledCapital: 10 }, { calledKnown: true })
    expect(slots(u)).toBe(0)
    expect(u.called).toBe(0)
  })
})
