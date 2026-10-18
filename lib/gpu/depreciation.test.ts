import { describe, it, expect } from 'vitest'
import { depreciableFromAsset, depreciationEntryDate, depreciationForMonth, depreciationSchedule, nbvAsOf, type DepreciableAsset } from './depreciation'
import { PACK_INPUTS, PACK_SERVERS } from './fixtures/pack-v3'
import type { GpuAssetRow } from './types'

// §2.7: the pack's three servers, salvage at 10%, 60 months, full-month convention.
const server = (id: string, cost: number, over: Partial<DepreciableAsset> = {}): DepreciableAsset => ({
  id, basis: cost, salvage: cost * 0.1, lifeMonths: 60, inServiceDate: '2027-01-15', convention: 'full_month', ...over,
})
const FLEET = PACK_SERVERS.map(s => server(s, PACK_INPUTS.servers[s].cost))

describe('§2.7 fixture', () => {
  it('depreciates 5,025 / 6,150 / 8,400 a month, 234,900 a year', () => {
    expect(FLEET.map(a => depreciationForMonth(a, '2027-01'))).toEqual([5025, 6150, 8400])
    const year = FLEET.flatMap(depreciationSchedule).filter(l => l.month.startsWith('2027')).reduce((s, l) => s + l.amount, 0)
    expect(year).toBe(234_900)
  })

  it('runs exactly 60 months and leaves NBV 130,500 (the salvage) at month 60', () => {
    for (const a of FLEET) {
      const s = depreciationSchedule(a)
      expect(s).toHaveLength(60)
      expect([s[0].month, s[59].month]).toEqual(['2027-01', '2031-12'])
      expect(s[59].accumulated).toBe(a.basis - a.salvage)
    }
    expect(FLEET.reduce((t, a) => t + nbvAsOf(a, '2031-12-31'), 0)).toBe(130_500)
  })

  it('counts a month in NBV only once its month end has passed', () => {
    const [h200] = FLEET
    expect(nbvAsOf(h200, '2026-12-31')).toBe(335_000)
    expect(nbvAsOf(h200, '2027-01-30')).toBe(335_000)
    expect(nbvAsOf(h200, '2027-01-31')).toBe(329_975)
    expect(nbvAsOf(h200, '2040-01-01')).toBe(33_500)
  })
})

describe('rounding and conventions', () => {
  it('puts the rounding in the final month on a non-divisible basis', () => {
    const s = depreciationSchedule(server('x', 100_000, { salvage: 0, lifeMonths: 7 }))
    expect(s.slice(0, 6).every(l => l.amount === 14_285.71)).toBe(true)
    expect(s[6].amount).toBe(14_285.74)
    expect(s[6].accumulated).toBe(100_000)
    expect(s[6].nbv).toBe(0)
  })

  it('mid_month: half a charge in the first and last months, lifeMonths + 1 months in all', () => {
    const s = depreciationSchedule(server('h', 335_000, { convention: 'mid_month' }))
    expect(s).toHaveLength(61)
    expect([s[0].amount, s[1].amount, s[59].amount, s[60].amount]).toEqual([2512.5, 5025, 5025, 2512.5])
    expect(s[60].accumulated).toBe(301_500)
  })

  it('stops after the disposal month and never reaches the true-up', () => {
    const s = depreciationSchedule(server('h', 335_000, { disposedOn: '2028-06-10' }))
    expect(s.at(-1)).toMatchObject({ month: '2028-06', amount: 5025, accumulated: 5025 * 18 })
    const mid = depreciationSchedule(server('h', 335_000, { convention: 'mid_month', disposedOn: '2028-06-10' }))
    expect(mid.at(-1)).toMatchObject({ month: '2028-06', amount: 2512.5 })
  })

  it('nothing to depreciate when salvage covers the basis', () => {
    expect(depreciationSchedule(server('z', 1000, { salvage: 1000 }))).toEqual([])
  })
})

describe('depreciableFromAsset', () => {
  const row = {
    id: 'a', hardware_cost: 335_000, salvage_value: 33_500, useful_life_months: 60,
    in_service_date: '2027-01-15', depreciation_convention: 'full_month', disposed_on: null,
  } as unknown as GpuAssetRow

  it('depreciates hardware from in-service and the posted capex as events; waits for an in-service date', () => {
    expect(depreciableFromAsset(row, [{ month: '2027-01', amount: 4_250.5 }])).toMatchObject({ basis: 335_000, salvage: 33_500, lifeMonths: 60, capex: [{ month: '2027-01', amount: 4_250.5 }] })
    expect(depreciableFromAsset({ ...row, in_service_date: null })).toBeNull()
  })

  it('starts a back-dated capex at the first month not yet posted (X)', () => {
    const posted = new Set(Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, '0')}`))
    const a = depreciableFromAsset(row, [{ month: '2027-10', amount: 4_800 }], posted)!
    expect(a.capex).toEqual([{ month: '2028-01', amount: 4_800 }])
    const s = depreciationSchedule(a)
    expect(s.slice(0, 12).every(l => l.amount === 5_025)).toBe(true)
    expect(s[12]).toMatchObject({ month: '2028-01', amount: 5_125 })
    expect(s.at(-1)!.accumulated).toBe(335_000 + 4_800 - 33_500)
  })
})

describe('capex is depreciated prospectively (Q)', () => {
  // 4,800 booked in month 13 of 60 adds 4,800 / 48 = 100 a month from that month on.
  const withCapex = server('h', 335_000, { capex: [{ month: '2028-01', amount: 4_800 }] })

  it('leaves the months before the capex unchanged and spreads it over the remaining life', () => {
    const s = depreciationSchedule(withCapex)
    const before = depreciationSchedule(server('h', 335_000))
    expect(s.slice(0, 12).map(l => l.amount)).toEqual(before.slice(0, 12).map(l => l.amount))
    expect(s[12]).toMatchObject({ month: '2028-01', amount: 5_125 })
    expect(s.at(-1)!.amount).toBe(5_125)
    expect(s.reduce((t, l) => t + l.amount, 0)).toBe(335_000 + 4_800 - 33_500)
    expect(s.at(-1)!.nbv).toBe(33_500)
  })

  it('a non-divisible capex still ends exactly at basis + capex − salvage', () => {
    const s = depreciationSchedule(server('h', 335_000, { capex: [{ month: '2027-07', amount: 1_000 }, { month: '2030-02', amount: 777.77 }] }))
    expect(Math.round(s.at(-1)!.accumulated * 100)).toBe((335_000 + 1_000 + 777.77 - 33_500) * 100)
  })

  it('counts capex in NBV from its month', () => {
    expect(nbvAsOf(withCapex, '2027-12-31')).toBe(335_000 - 5_025 * 12)
    expect(nbvAsOf(withCapex, '2028-01-31')).toBe(335_000 + 4_800 - 5_025 * 12 - 5_125)
  })

})

describe('depreciationEntryDate', () => {
  it('is the month end, or the disposal date in the month of disposal', () => {
    expect(depreciationEntryDate('2028-06')).toBe('2028-06-30')
    expect(depreciationEntryDate('2028-06', '2028-06-10')).toBe('2028-06-10')
    expect(depreciationEntryDate('2028-05', '2028-06-10')).toBe('2028-05-31')
  })
})
