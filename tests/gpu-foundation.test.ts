import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

/**
 * GPU SPV foundation (P1a): the `gpu_spv` kind, the `gpu_fleet` switch and the `fleet` area.
 *
 * The promise this pins is that NOTHING CHANGES for a VC fund. `gpu_fleet` ships off, so every
 * existing domain resolves exactly as it did before `fleet` existed (the expected maps below were
 * captured from `accessMap` on main @ d40d63ae), and `fleet` itself is none for everyone, admins
 * included. Then: the `requires: 'accounting'` rule, and the two kind checks a fleet route and a
 * fleet page use to refuse a VC entity.
 */

const s = vi.hoisted(() => ({ m: null as any, page: null as any }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/supabase/server', () => ({ getUser: async () => ({ id: 'u' }) }))
vi.mock('@/lib/access/page-gate', () => ({
  resolvePageAccess: async () => s.page,
  canViewPage: () => true,
}))
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
}))

import { accessMap, effectiveAccess, type AccessContext } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { assertVehicleKind, domainForVehicleKind } from '@/lib/accounting/vehicle-domain'
import { requireVehicleAccess } from '@/app/(app)/funds/guard'
import TaxPage from '@/app/(app)/funds/[id]/tax/page'
import { kindIsOneOf, closesToOwnerEquity, isGpuSpv, kindOptionsFor, GPU_SPV_KIND } from '@/lib/vehicle-kinds'

const VC_FEATURES = {
  ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', lps: 'everyone', lp_tracking: 'everyone', gp_economics: 'admin',
  tax_reporting: 'everyone', management_company: 'everyone', compliance: 'everyone', deals: 'everyone',
} as FeatureVisibilityMap
const VC_DEFAULTS = {
  portfolio: 'write', relationships: 'write', dealflow: 'write', diligence: 'write', accounting: 'write', lp_capital: 'write',
  gp_economics: 'write', lp_relations: 'write', compliance: 'write', tax: 'write', management_company: 'none',
} as AccessContext['defaults']
const base = { fundId: 'f', userId: 'u', vehicles: { all: true, ids: [] }, features: VC_FEATURES, defaults: VC_DEFAULTS }
const ctx = (over: Partial<AccessContext>): AccessContext => ({ ...base, role: 'member', grants: {}, ...over }) as AccessContext

// accessMap on main @ d40d63ae, before `fleet` existed.
const BEFORE = {
  admin: { portfolio: 'write', relationships: 'write', dealflow: 'write', diligence: 'none', accounting: 'write', management_company: 'write', lp_capital: 'write', gp_economics: 'write', lp_relations: 'write', compliance: 'write', tax: 'write', admin: 'write' },
  member: { portfolio: 'write', relationships: 'write', dealflow: 'none', diligence: 'none', accounting: 'read', management_company: 'none', lp_capital: 'write', gp_economics: 'none', lp_relations: 'write', compliance: 'write', tax: 'write', admin: 'none' },
  bare: { portfolio: 'none', relationships: 'none', dealflow: 'none', diligence: 'none', accounting: 'none', management_company: 'none', lp_capital: 'none', gp_economics: 'none', lp_relations: 'none', compliance: 'none', tax: 'none', admin: 'none' },
}
const FIXTURES = {
  admin: ctx({ role: 'admin' }),
  member: ctx({ grants: { accounting: 'read', dealflow: 'none', tax: 'write' } }),
  bare: ctx({ defaults: {}, features: DEFAULT_FEATURE_VISIBILITY }),
}

describe('a VC fund with gpu_fleet off is unchanged', () => {
  for (const [who, c] of Object.entries(FIXTURES) as [keyof typeof FIXTURES, AccessContext][]) {
    it(`${who}: every existing domain resolves as before, and fleet is none`, () => {
      const { fleet, ...rest } = accessMap(c)
      expect(rest).toEqual(BEFORE[who])
      expect(fleet).toBe('none')
    })
  }

  it('denies fleet to an admin even when the member grant says write', () => {
    expect(effectiveAccess(ctx({ role: 'admin', grants: { fleet: 'write' } }), 'fleet')).toBe('none')
  })
})

describe('fleet requires reading the books', () => {
  const on = { ...VC_FEATURES, gpu_fleet: 'everyone' } as FeatureVisibilityMap

  it('is write with a fleet grant and accounting read', () => {
    expect(effectiveAccess(ctx({ features: on, grants: { fleet: 'write', accounting: 'read' } }), 'fleet')).toBe('write')
  })

  it('is none with a fleet grant but no accounting', () => {
    expect(effectiveAccess(ctx({ features: on, grants: { fleet: 'write', accounting: 'none' } }), 'fleet')).toBe('none')
  })

  it('falls back to the accounting level before the migration seeds a fleet default', () => {
    // VC_DEFAULTS has no `fleet` row: the state between a deploy and `supabase db push`.
    expect(effectiveAccess(ctx({ features: on }), 'fleet')).toBe('write')
    expect(effectiveAccess(ctx({ features: on, grants: { accounting: 'read' } }), 'fleet')).toBe('read')
  })

  it('is write for an admin and read for a viewer once the switch is on', () => {
    expect(effectiveAccess(ctx({ role: 'admin', features: on }), 'fleet')).toBe('write')
    expect(effectiveAccess(ctx({ role: 'viewer', features: on }), 'fleet')).toBe('read')
  })

  it('is none for an admin and a viewer too when accounting is off (#70)', () => {
    const noBooks = { ...on, accounting: 'off' } as FeatureVisibilityMap
    expect(effectiveAccess(ctx({ role: 'admin', features: noBooks }), 'fleet')).toBe('none')
    expect(effectiveAccess(ctx({ role: 'viewer', features: noBooks }), 'fleet')).toBe('none')
  })
})

describe('the gpu_spv kind', () => {
  it('closes to partners and keeps its books under accounting', () => {
    expect(isGpuSpv('gpu_spv')).toBe(true)
    expect(isGpuSpv('spv')).toBe(false)
    expect(closesToOwnerEquity('gpu_spv')).toBe(false)
    expect(domainForVehicleKind('gpu_spv')).toBe('accounting')
  })

  it('kindIsOneOf never matches a legacy null kind', () => {
    expect(kindIsOneOf('gpu_spv', ['gpu_spv'])).toBe(true)
    expect(kindIsOneOf('spv', ['gpu_spv'])).toBe(false)
    expect(kindIsOneOf(null, ['gpu_spv', 'fund'])).toBe(false)
  })

  it('is offered in a picker only to someone who can write the fleet, or when it is already the kind', () => {
    const values = (o: { value: string }[]) => o.map(k => k.value)
    expect(values(kindOptionsFor(false))).not.toContain(GPU_SPV_KIND)
    expect(values(kindOptionsFor(false))).toEqual(['fund', 'spv', 'direct', 'associate', 'individual', 'manco', 'other'])
    expect(values(kindOptionsFor(true))).toContain(GPU_SPV_KIND)
    expect(values(kindOptionsFor(false, 'gpu_spv'))).toContain(GPU_SPV_KIND)
  })
})

describe('assertVehicleKind', () => {
  beforeEach(() => {
    s.m = memoryAdmin({ fund_vehicles: [
      { id: 'v-vc', fund_id: 'f', name: 'Acme SPV', kind: 'spv', aliases: [] },
      { id: 'v-gpu', fund_id: 'f', name: 'H200 SPV I', kind: 'gpu_spv', aliases: ['H200 I'] },
    ] })
  })

  it('refuses a VC SPV as not found', async () => {
    const res = await assertVehicleKind(s.m.admin, 'f', 'Acme SPV', 'gpu_spv')
    expect(res?.status).toBe(404)
  })

  it('refuses a legacy name with no registry row', async () => {
    expect((await assertVehicleKind(s.m.admin, 'f', 'Old Fund', 'gpu_spv'))?.status).toBe(404)
  })

  it('admits a GPU SPV, by name or alias', async () => {
    expect(await assertVehicleKind(s.m.admin, 'f', 'H200 SPV I', 'gpu_spv')).toBeNull()
    expect(await assertVehicleKind(s.m.admin, 'f', 'H200 I', 'gpu_spv')).toBeNull()
  })

  it('does not cross funds', async () => {
    expect((await assertVehicleKind(s.m.admin, 'other-fund', 'H200 SPV I', 'gpu_spv'))?.status).toBe(404)
  })
})

describe('requireVehicleAccess({ kinds })', () => {
  const VC = '00000000-0000-4000-8000-000000000001'
  const GPU = '00000000-0000-4000-8000-000000000002'
  beforeEach(() => {
    s.m = memoryAdmin({ fund_vehicles: [
      { id: VC, fund_id: 'f', name: 'Acme SPV', kind: 'spv', active: true },
      { id: GPU, fund_id: 'f', name: 'H200 SPV I', kind: 'gpu_spv', active: true },
    ] })
    s.page = { fundId: 'f', role: 'admin', access: { vehicles: { all: true, ids: [] } } }
  })

  it('gives not-found for a VC entity on a GPU-only page', async () => {
    await expect(requireVehicleAccess(VC, { kinds: ['gpu_spv'] })).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('gives not-found for a legacy entity addressed by name', async () => {
    await expect(requireVehicleAccess('Old Fund', { kinds: ['gpu_spv'] })).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('admits a GPU SPV', async () => {
    await expect(requireVehicleAccess(GPU, { kinds: ['gpu_spv'] })).resolves.toMatchObject({ vehicle: 'H200 SPV I', kind: 'gpu_spv' })
  })

  it('without `kinds`, admits any entity as before', async () => {
    await expect(requireVehicleAccess(VC)).resolves.toMatchObject({ vehicle: 'Acme SPV', kind: 'spv' })
    await expect(requireVehicleAccess('Old Fund')).resolves.toMatchObject({ vehicle: 'Old Fund', kind: null })
  })

  it('the Tax page is not found on a GPU SPV and still renders on a VC entity', async () => {
    const page = (id: string) => TaxPage({ params: Promise.resolve({ id }) })
    await expect(page(GPU)).rejects.toThrow('NEXT_NOT_FOUND')
    await expect(page(VC)).resolves.toBeTruthy()
  })
})
