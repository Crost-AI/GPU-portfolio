import { describe, expect, it } from 'vitest'
import { memoryAdmin } from '../../tests/helpers/memory-admin'
import { copyConstructionToPlansWithout, loadPlanConstruction, pickPrimaryPlan, setPrimaryPlan, writePlanConstruction } from './plan-construction'

const seed = async () => ({ fromSeed: true })
const books = (plans: any[]) => memoryAdmin({
  forecast_plans: plans.map(p => ({ fund_id: 'f', vehicle_id: 'v', revision: 1, construction: null, is_primary: false, status: 'active', kind: 'rolling_forecast', created_at: '2026-01-01', ...p })),
})

describe("a plan's portfolio construction", () => {
  it('reads the seed until a plan has its own — so nothing changes before the first save', async () => {
    const { admin } = books([{ id: 'p1', name: 'Base case', is_primary: true }])
    const ref = await loadPlanConstruction(admin as any, 'f', 'v', null, seed)
    expect(ref).toMatchObject({ planId: 'p1', isPrimary: true, source: 'seed', assumptions: { fromSeed: true } })
  })

  it("uses a plan's own construction once saved, and a named plan's over the primary's", async () => {
    const { admin } = books([
      { id: 'p1', name: 'Base case', is_primary: true, construction: { case: 'base' } },
      { id: 'p2', name: 'Downside', construction: { case: 'down' } },
    ])
    expect((await loadPlanConstruction(admin as any, 'f', 'v', null, seed)).assumptions).toEqual({ case: 'base' })
    expect((await loadPlanConstruction(admin as any, 'f', 'v', 'p2', seed)).assumptions).toEqual({ case: 'down' })
  })

  it('saving bumps the revision, and the first save copies it to every plan still without one', async () => {
    const { admin, tables } = books([
      { id: 'p1', name: 'Base case', is_primary: true },
      { id: 'p2', name: 'Budget', kind: 'budget' },
      { id: 'p3', name: 'Downside', construction: { case: 'down' } },
    ])
    await writePlanConstruction(admin as any, 'f', 'p1', { case: 'base' })
    expect(await copyConstructionToPlansWithout(admin as any, 'f', 'v', { case: 'base' }, 'p1')).toBe(1)
    const byId = Object.fromEntries(tables.forecast_plans.map((p: any) => [p.id, p]))
    expect(byId.p1).toMatchObject({ construction: { case: 'base' }, revision: 2 })
    expect(byId.p2.construction).toEqual({ case: 'base' })
    expect(byId.p3.construction).toEqual({ case: 'down' }) // its own scenario is left alone
  })

  it('keeps exactly one primary plan, choosing the first active rolling forecast when none is marked', async () => {
    const { admin, tables } = books([
      { id: 'b', name: '2027 budget', kind: 'budget', created_at: '2026-01-01' },
      { id: 'r', name: 'Rolling', created_at: '2026-02-01' },
    ])
    expect(await pickPrimaryPlan(admin as any, 'f', 'v')).toBe('r')
    await setPrimaryPlan(admin as any, 'f', 'v', 'b')
    expect(tables.forecast_plans.filter((p: any) => p.is_primary).map((p: any) => p.id)).toEqual(['b'])
  })
})
