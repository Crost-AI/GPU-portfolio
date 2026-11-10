import { describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// ── GPU fleet (P3) ── Upstream #147/#148 add set_holding_type and merge_companies. A GPU SPV's fleet
// company (holding_type 'gpu_fleet') is the SPV's own: neither may change its kind or merge it, in
// either direction, and nothing is written when refused.

vi.mock('@/lib/activity', () => ({ logActivity: () => {} }))
import { setHoldingType } from '@/lib/companies/holding-edit'
import { mergeCompanies } from '@/lib/companies/merge'

const world = () => memoryAdmin({
  companies: [
    { id: 'fleet-co', fund_id: 'f', name: 'GPU fleet', aliases: [], holding_type: 'gpu_fleet', portfolio_group: ['GPU SPV I'] },
    { id: 'acme', fund_id: 'f', name: 'Acme', aliases: [], holding_type: 'company', portfolio_group: ['Fund I'] },
  ],
})
const who = { fundId: 'f', userId: 'u' }
const scope = async () => ({ access: { fundId: 'f', vehicles: { all: true, ids: [] } } as any, vehicleNames: null })

describe('a GPU SPV fleet company', () => {
  it.each(['company', 'fund'] as const)('cannot be changed into a %s', async (type) => {
    const m = world()
    const out = await setHoldingType(m.admin as any, who, 'fleet-co', type)
    expect(out).toMatchObject({ ok: false, status: 400 })
    expect(m.tables.companies.find((c: any) => c.id === 'fleet-co')!.holding_type).toBe('gpu_fleet')
  })

  it('cannot be merged away, or have a holding merged into it', async () => {
    for (const [from, into] of [['fleet-co', 'acme'], ['acme', 'fleet-co']]) {
      const m = world()
      const out = await mergeCompanies(m.admin as any, { ...who, vehicleNames: null }, from, into, scope)
      expect(out, `${from} into ${into}`).toMatchObject({ ok: false, status: 400 })
      expect(m.tables.companies).toHaveLength(2)
      expect(m.tables.companies.find((c: any) => c.id === 'acme')!.aliases).toEqual([])
    }
  })

  it('an ordinary company still changes kind', async () => {
    const m = world()
    expect(await setHoldingType(m.admin as any, who, 'acme', 'fund')).toMatchObject({ ok: true })
  })
})
