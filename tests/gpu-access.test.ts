import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * ── GPU fleet (P5) ── The isolation matrix of the pivot plan §6.4, for the pages and the nav.
 *
 *   1. A VC fund (gpu_fleet off, the default) sees nothing GPU: no sidebar entry, no GPU section in
 *      any entity's subnav, whoever the caller is — admins included.
 *   2. With gpu_fleet on and a fleet grant, a VC entity still shows no GPU section: they are
 *      `showFor: ['gpu_spv']`, and a legacy null kind never matches.
 *   3. A GPU SPV hides only what has no meaning on it (schedule of investments; Tax until #68).
 *   4. Every GPU entity page asks the gate for the kind, so a VC entity's id is not found.
 *
 * Pure functions and page source only; the gate's own behaviour is pinned in gpu-foundation.test.ts.
 */

import { canSee, navSectionsFor, fundsChildrenFor, visibleChildrenFor, fundSegFromPath, type NavItem } from '@/components/app-sidebar'
import { effectiveAccess, type AccessContext } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureKey, type FeatureVisibilityMap } from '@/lib/types/features'
import type { Domain } from '@/lib/access/domains'
import { hasSectionForKind } from '@/lib/accounting/nav'
import { FUND_SUBPAGE_SLUGS } from '@/components/fund-subpages'
import { PAGE_DOMAINS } from '@/lib/access/page-domains'
import { forecastTabsFor } from '@/app/(app)/funds/forecast/view'

const SEG = '00000000-0000-4000-8000-0000000000aa'
const GPU_SLUGS = ['fleet', 'revenue', 'waterfall', 'scenarios']
const gpuHrefs = (seg: string | null) => GPU_SLUGS.map(s => (seg ? `/funds/${seg}/${s}` : `/funds/${s}`))
const hrefs = (items: { href: string }[]) => items.map(i => i.href)

// A VC fund that keeps books and reports to LPs; gpu_fleet left at its default.
const VC_FEATURES = {
  ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', lps: 'everyone', lp_tracking: 'everyone', gp_economics: 'admin',
} as FeatureVisibilityMap
const ctx = (role: string, grants: AccessContext['grants'], features: FeatureVisibilityMap = VC_FEATURES): AccessContext =>
  ({ fundId: 'f', userId: 'u', role, vehicles: { all: true, ids: [] }, features, grants, defaults: {} }) as AccessContext
const bound = (c: AccessContext) => (d: Domain, f?: FeatureKey) => effectiveAccess(c, d, f)

const CALLERS = {
  admin: ctx('admin', {}),
  'member with accounting write': ctx('member', { accounting: 'write', fleet: 'write' }),
  viewer: ctx('viewer', {}),
}

// The sidebar entry itself, found through the list every caller's nav is filtered from.
const FLEET_ITEM = navSectionsFor(true, () => 'write').find(i => i.href === '/fleet') as NavItem

describe('1. a VC fund with gpu_fleet off sees nothing GPU', () => {
  it('finds the /fleet sidebar entry at all (guards against a vacuous pass)', () => {
    expect(FLEET_ITEM).toMatchObject({ href: '/fleet', featureKey: 'gpu_fleet' })
  })

  for (const features of [VC_FEATURES, DEFAULT_FEATURE_VISIBILITY]) {
    for (const [who, base] of Object.entries(CALLERS)) {
      it(`${who}${features === DEFAULT_FEATURE_VISIBILITY ? ' (every switch at its default)' : ''}`, () => {
        const c = { ...base, features }
        const isAdmin = c.role === 'admin'
        expect(effectiveAccess(c, 'fleet')).toBe('none')
        expect(canSee(FLEET_ITEM, isAdmin, bound(c))).toBe(false)
        expect(hrefs(navSectionsFor(isAdmin, bound(c)))).not.toContain('/fleet')
        for (const h of gpuHrefs(SEG)) expect(hrefs(fundsChildrenFor(SEG, false, 'fund'))).not.toContain(h)
      })
    }
  }

  it('even a GPU SPV’s Fleet and Revenue links are filtered out while the switch is off', () => {
    const funds = navSectionsFor(true, () => 'write').find(i => i.href === '/funds') as NavItem
    const kids = hrefs(visibleChildrenFor(funds, true, bound(CALLERS.admin), { fundSeg: SEG, kind: 'gpu_spv' }))
    expect(kids).not.toContain(`/funds/${SEG}/fleet`)
    expect(kids).not.toContain(`/funds/${SEG}/revenue`)
  })
})

describe('2. a VC entity shows no GPU section, even with gpu_fleet on and a fleet grant', () => {
  const on = { ...VC_FEATURES, gpu_fleet: 'everyone' } as FeatureVisibilityMap
  const member = ctx('member', { accounting: 'write', fleet: 'write', lp_capital: 'write' }, on)

  it('the switch and the grant really are on (guards against a vacuous pass)', () => {
    expect(effectiveAccess(member, 'fleet')).toBe('write')
    expect(canSee(FLEET_ITEM, false, bound(member))).toBe(true)
  })

  for (const kind of ['fund', 'spv', 'direct', 'associate', 'individual', 'manco', 'other', null]) {
    it(String(kind), () => {
      const funds = navSectionsFor(false, bound(member)).find(i => i.href === '/funds') as NavItem
      const plain = hrefs(fundsChildrenFor(SEG, false, kind))
      const visible = hrefs(visibleChildrenFor(funds, false, bound(member), { fundSeg: SEG, kind }))
      for (const h of gpuHrefs(SEG)) {
        expect(plain).not.toContain(h)
        expect(visible).not.toContain(h)
      }
      for (const slug of GPU_SLUGS) expect(hasSectionForKind(slug, kind)).toBe(false)
    })
  }

  it('the firm-wide subnav lists none of them either', () => {
    for (const h of gpuHrefs(null)) expect(hrefs(fundsChildrenFor(null, false, null))).not.toContain(h)
  })

  it('hasSectionForKind(‘fleet’, ‘fund’) is false, so the firm-wide landing lists no VC entity', () => {
    expect(hasSectionForKind('fleet', 'fund')).toBe(false)
  })
})

describe('3. a GPU SPV hides only what has no meaning on it', () => {
  const kids = hrefs(fundsChildrenFor(SEG, false, 'gpu_spv'))
  const at = (slug: string) => `/funds/${SEG}/${slug}`

  it('has the four GPU sections', () => {
    for (const h of gpuHrefs(SEG)) expect(kids).toContain(h)
    for (const slug of GPU_SLUGS) expect(hasSectionForKind(slug, 'gpu_spv')).toBe(true)
  })

  it('keeps every shared section of the books', () => {
    for (const slug of ['status', 'bank', 'receipts', 'capital-accounts', 'journal', 'ledger', 'periods', 'performance', 'forecast', 'statements']) {
      expect(kids, slug).toContain(at(slug))
    }
  })

  it('drops the schedule of investments, and Tax until #68', () => {
    expect(kids).not.toContain(at('schedule-of-investments'))
    expect(kids).not.toContain(at('tax'))
  })
})

describe('4. every GPU page asks for the kind', () => {
  const APP = path.join(process.cwd(), 'app', '(app)')
  const src = (key: string) => readFileSync(path.join(APP, key, 'page.tsx'), 'utf8')
  const ENTITY_PAGES = ['funds/[id]/fleet', 'funds/[id]/fleet/[assetId]', 'funds/[id]/revenue', 'funds/[id]/waterfall', 'funds/[id]/scenarios']

  it.each(ENTITY_PAGES)('%s calls requireVehicleAccess with kinds: [‘gpu_spv’]', key => {
    expect(src(key)).toMatch(/requireVehicleAccess\([^)]*kinds:\s*\['gpu_spv'\]/)
    expect(PAGE_DOMAINS[key]?.gate).toBe('requireVehicleAccess')
  })

  it('the fleet register, asset detail and revenue also need the fleet grant behind gpu_fleet', () => {
    for (const key of ['funds/[id]/fleet', 'funds/[id]/fleet/[assetId]', 'funds/[id]/revenue']) {
      expect(src(key)).toMatch(/requireVehicleAccess\(params\.id, \{ domain: 'fleet', feature: 'gpu_fleet', kinds: \['gpu_spv'\] \}\)/)
      expect(PAGE_DOMAINS[key]).toEqual({ domain: 'fleet', feature: 'gpu_fleet', gate: 'requireVehicleAccess' })
    }
  })

  it('the waterfall needs investors’ capital', () => {
    expect(src('funds/[id]/waterfall')).toMatch(/requireVehicleAccess\(params\.id, \{ domain: 'lp_capital', kinds: \['gpu_spv'\] \}\)/)
    expect(PAGE_DOMAINS['funds/[id]/waterfall']).toEqual({ domain: 'lp_capital', gate: 'requireVehicleAccess' })
  })

  it('the firm-wide /fleet gates on fleet behind gpu_fleet, before it queries', () => {
    const page = src('fleet')
    const gateAt = page.indexOf("canViewPage(page, 'fleet', 'gpu_fleet')")
    expect(gateAt).toBeGreaterThan(-1)
    expect(gateAt).toBeLessThan(page.search(/\.from\(['"]/))
    expect(page).toContain('canSeeVehicle(page.access, v.id)')
    expect(PAGE_DOMAINS.fleet).toEqual({ domain: 'fleet', feature: 'gpu_fleet' })
  })
})

describe('5. the four slugs are section landings, not entities', () => {
  it('is in FUND_SUBPAGE_SLUGS', () => {
    for (const slug of GPU_SLUGS) expect(FUND_SUBPAGE_SLUGS.has(slug)).toBe(true)
  })

  it('/funds/fleet is the firm-wide landing; /funds/<id>/fleet is inside the entity', () => {
    expect(fundSegFromPath('/funds/fleet')).toBeNull()
    expect(fundSegFromPath(`/funds/${SEG}/fleet`)).toBe(SEG)
  })
})

describe('6. the Forecast page on a GPU SPV', () => {
  it('swaps Investments for Fleet', () => {
    expect(forecastTabsFor('gpu_spv')).toEqual(['charts', 'fleet', 'capital', 'financials'])
  })

  it('leaves every other kind’s tabs as they were', () => {
    expect(forecastTabsFor('fund')).toEqual(['charts', 'investments', 'capital', 'financials'])
    expect(forecastTabsFor('manco')).toEqual(['charts', 'financials', 'capital'])
  })
})
