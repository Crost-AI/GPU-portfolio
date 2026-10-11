import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'
import type { AccessContext } from '@/lib/access/effective'

/**
 * Linked fees (acceptance #9): the manco's revenue is the fund's construction fee schedule on the
 * link's billing cycle, and a manco planner who cannot see the fund gets the amount and nothing else.
 */

const mocks = vi.hoisted(() => ({ getConstructionModel: vi.fn() }))
vi.mock('@/lib/accounting/construction-service', () => ({ getConstructionModel: mocks.getConstructionModel }))
// A GP entity (GP I LLC, lp-gp) of Fund II: 12.5% of its commitments, 60% of its carry.
vi.mock('@/lib/accounting/gp-economics', () => ({
  gpLinkFor: async () => ({ servesVehicle: 'Fund II', servesVehicleId: 'v2', lpEntityId: 'lp-gp' }),
}))
vi.mock('@/lib/accounting/capital-calls', () => ({
  lpCapitalSummary: async () => [{ lpEntityId: 'lp-gp', commitment: 125 }, { lpEntityId: 'lp-a', commitment: 875 }],
}))
vi.mock('@/lib/accounting/carry', () => ({
  loadCarryTerms: async () => ({ recipients: [{ lpEntityId: 'lp-gp', pct: 60 }, { lpEntityId: 'lp-b', pct: 40 }] }),
}))

import { gpShareOf, loadLinkedDrivers } from '@/lib/forecast/linked'
import { validateRule } from '@/lib/forecast/rules'

/** A thenable query builder that answers per table. */
function fakeAdmin(tables: Record<string, any[]>) {
  return {
    from(table: string) {
      const q: any = {
        select: () => q, eq: () => q, in: () => q, or: () => q, limit: () => q, order: () => q,
        maybeSingle: () => Promise.resolve({ data: (tables[table] ?? [])[0] ?? null, error: null }),
        then: (res: any) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(res),
      }
      return q
    },
  } as any
}

const access = (vehicleIds: string[] | 'all'): AccessContext => ({
  fundId: 'f1', userId: 'u1', role: 'member',
  vehicles: vehicleIds === 'all' ? { all: true, ids: [] } : { all: false, ids: vehicleIds },
  features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', management_company: 'everyone' },
  grants: { accounting: 'read', management_company: 'write' },
  defaults: {},
})

const schedule = {
  horizonYears: 2, stated: true, warnings: [], deals: [],
  years: [
    { year: 0, calendarYear: 2026, invested: 0, fees: 0, expenses: 0, called: 0, distributed: 0, cumCalled: 0, cumInvested: 0, cumDistributed: 0, nav: 0, dpi: null, rvpi: null, tvpi: null, netIrr: null },
    { year: 1, calendarYear: 2027, invested: 0, fees: 1_200_000, expenses: 0, called: 0, distributed: 0, cumCalled: 0, cumInvested: 0, cumDistributed: 0, nav: 0, dpi: null, rvpi: null, tvpi: null, netIrr: null },
    { year: 2, calendarYear: 2028, invested: 0, fees: 1_200_000, expenses: 0, called: 0, distributed: 0, cumCalled: 0, cumInvested: 0, cumDistributed: 0, nav: 0, dpi: null, rvpi: null, tvpi: null, netIrr: null },
  ],
}

const ADMIN = fakeAdmin({
  manco_fee_links: [{ id: 'l1', manco_vehicle_id: 'm1', fund_vehicle_id: 'v2', every_months: 3, anchor_month: 1, direction: 'advance', cash_lag_months: 0, active: true }],
  fund_vehicles: [{ id: 'm1', name: 'Hemrock Management' }, { id: 'v2', name: 'Fund II' }],
})

const feeRule = [{ id: 'r1', accountId: 'a4000', rule: validateRule('linked_fee', {}), cashTiming: { mode: 'same' as const } }]
const MANCO = { id: 'm1', name: 'Hemrock Management', kind: 'manco' }

beforeEach(() => {
  mocks.getConstructionModel.mockReset()
  mocks.getConstructionModel.mockResolvedValue({ timeline: schedule, timelineNetOfCarry: false, grossTimeline: null, asOf: '2026-12-15T00:00:00Z' })
})

describe('linked management fees', () => {
  it("are the fund's construction fees, monthly, on the link's billing cycle", async () => {
    const r = await loadLinkedDrivers({ admin: ADMIN, fundId: 'f1', access: access('all') }, MANCO, feeRule, false)
    const [d] = r.linked.get('r1')!
    expect(d.amounts.get('2027-01')).toBe(100_000)
    expect([...d.amounts.values()].reduce((a, b) => a + b, 0)).toBe(2_400_000)
    expect(d.timing).toEqual({ mode: 'cycle', everyMonths: 3, anchor: 1, direction: 'advance', lagMonths: 0 })
    expect(d.basis).toContain('Fund II')
  })

  it('reveal only the amount for a fund the caller cannot see', async () => {
    const r = await loadLinkedDrivers({ admin: ADMIN, fundId: 'f1', access: access(['m1']) }, MANCO, feeRule, false)
    const [d] = r.linked.get('r1')!
    expect(d.amounts.get('2027-01')).toBe(100_000)
    expect(d.basis).not.toContain('Fund II')
    expect(d.basis).toContain('details restricted')
    expect(JSON.stringify(r)).not.toContain('Fund II')
    // The schedule was read with the books opened for this one calculation — not the caller's scope.
    expect(mocks.getConstructionModel.mock.calls[0][0].access.vehicles).toEqual({ all: true, ids: [] })
  })

  it("come from the fund's own fee rule once its primary plan has one — one schedule, both sides", async () => {
    const withPlan = fakeAdmin({
      manco_fee_links: [{ id: 'l1', manco_vehicle_id: 'm1', fund_vehicle_id: 'v2', every_months: 3, anchor_month: 1, direction: 'advance', cash_lag_months: 0, active: true }],
      fund_vehicles: [{ id: 'm1', name: 'Hemrock Management' }, { id: 'v2', name: 'Fund II' }],
      forecast_plans: [{ id: 'pp', name: 'Base case', is_primary: true }],
      forecast_rules: [{ params: { rate: 0.02, basis: 'committed', termYears: 10, stepDownYear: null, stepDownRate: null } }],
    })
    mocks.getConstructionModel.mockResolvedValue({
      timeline: schedule, timelineNetOfCarry: false, grossTimeline: null, asOf: '2026-12-15T00:00:00Z',
      actuals: { committedCapital: 60_000_000, deployedInitial: 0, deployedFollowOn: 0, nav: 0, feePayingShare: 0.99 },
    })
    const r = await loadLinkedDrivers({ admin: withPlan, fundId: 'f1', access: access('all') }, MANCO, feeRule, false)
    const [d] = r.linked.get('r1')!
    // 2% of 60M, 99% fee-paying (the GP's stake exempt), a twelfth a month.
    expect(d.amounts.get('2027-01')).toBe(99_000)
    expect(d.basis).toContain("Fund II's forecast")
    expect(mocks.getConstructionModel.mock.calls[0][1]).toEqual({ vehicle: 'Fund II', planId: 'pp' })
  })

  it('never guess a link that is not there', async () => {
    const none = fakeAdmin({ manco_fee_links: [], fund_vehicles: [] })
    const r = await loadLinkedDrivers({ admin: none, fundId: 'f1', access: access('all') }, MANCO, feeRule, false)
    expect(r.linked.get('r1')).toEqual([])
    expect(r.warnings[0]).toMatch(/no linked funds/)
    expect(mocks.getConstructionModel).not.toHaveBeenCalled()
  })

  it("read the fund's own schedule with the caller's own access on the fund side", async () => {
    const r = await loadLinkedDrivers(
      { admin: ADMIN, fundId: 'f1', access: access(['v2']) },
      { id: 'v2', name: 'Fund II', kind: 'fund' },
      [{ id: 'r2', accountId: 'f5000', rule: validateRule('linked_fee', {}), cashTiming: { mode: 'same' } }],
      false,
    )
    expect(mocks.getConstructionModel.mock.calls[0][0].access.vehicles).toEqual({ all: false, ids: ['v2'] })
    expect(r.linked.get('r2')![0].basis).toContain('paid to Hemrock Management quarterly in advance')
  })
})

describe('what a caller without the grant learns', () => {
  const noManco = (vehicleIds: string[] | 'all'): AccessContext => ({ ...access(vehicleIds), grants: { accounting: 'read' } })

  it("does not name the manco or its billing cycle on the fund side without management_company", async () => {
    const r = await loadLinkedDrivers(
      { admin: ADMIN, fundId: 'f1', access: noManco(['v2']) },
      { id: 'v2', name: 'Fund II', kind: 'fund' },
      [{ id: 'r2', accountId: 'f5000', rule: validateRule('linked_fee', {}), cashTiming: { mode: 'same' } }],
      false,
    )
    const basis = r.linked.get('r2')![0].basis
    expect(basis).not.toMatch(/Hemrock|quarterly/)
    expect(basis).toContain('paid to the management company')
  })

  it("answers a manco's fund filter the same for a restricted linked fund as for an unlinked one", async () => {
    const run = (fundVehicle: string) => loadLinkedDrivers(
      { admin: ADMIN, fundId: 'f1', access: access(['m1']) }, MANCO,
      [{ id: 'r1', accountId: 'a4000', rule: validateRule('linked_fee', { fundVehicle }), cashTiming: { mode: 'same' as const } }], false,
    )
    const linked = await run('Fund II')
    const unlinked = await run('Fund IX')
    expect(linked.linked.get('r1')).toEqual(unlinked.linked.get('r1'))
    expect(linked.warnings.map(w => w.replace('Fund II', 'X'))).toEqual(unlinked.warnings.map(w => w.replace('Fund IX', 'X')))
    expect(mocks.getConstructionModel).not.toHaveBeenCalled()
  })

  it("gives a GP entity's planner without the fund amounts only — no share, no carry split", async () => {
    mocks.getConstructionModel.mockResolvedValue({
      timeline: schedule, timelineNetOfCarry: true, grossTimeline: schedule, asOf: '2026-12-15T00:00:00Z',
      actuals: { waterfall: { carryPaidInferred: 50_000 } },
    })
    const restricted = await gpShareOf({ admin: fakeAdmin({}), fundId: 'f1', access: noManco(['g1']) }, 'GP I LLC')
    const text = JSON.stringify({ basis: restricted!.basis, warnings: restricted!.warnings, fund: restricted!.fund })
    expect(text).not.toMatch(/12\.5%|60%|Fund II|50,000/)
    const full = await gpShareOf({ admin: fakeAdmin({}), fundId: 'f1', access: { ...access('all'), features: { ...access('all').features, gp_economics: 'everyone' }, grants: { accounting: 'read', gp_economics: 'read' } } }, 'GP I LLC')
    expect(full!.basis).toMatch(/12\.5% of Fund II/)
    expect(full!.basis).toMatch(/60% of its carry/)
    // Carry % needs gp_economics even when the fund is visible.
    const noCarry = await gpShareOf({ admin: fakeAdmin({}), fundId: 'f1', access: noManco('all') }, 'GP I LLC')
    expect(noCarry!.basis).toMatch(/12\.5% of Fund II/)
    expect(noCarry!.basis).not.toMatch(/60%/)
  })
})
