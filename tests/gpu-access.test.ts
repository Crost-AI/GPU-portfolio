import { describe, it, expect, vi, beforeEach } from 'vitest'
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
import { ACCOUNTING_SECTIONS } from '@/lib/accounting/nav'
import { requireGpuSectionAccess } from '@/app/(app)/funds/guard'

import { memoryAdmin } from '@/tests/helpers/memory-admin'
import EntityPage from '@/app/(app)/funds/[id]/page'
import WaterfallPage from '@/app/(app)/funds/[id]/waterfall/page'
import ScenariosPage from '@/app/(app)/funds/[id]/scenarios/page'
import FleetOverviewPage from '@/app/(app)/fleet/page'
import { GpuDetailView } from '@/app/(app)/funds/[id]/gpu-detail-view'
import { FundDetailView } from '@/app/(app)/funds/[id]/fund-detail-view'
import { FleetOverview } from '@/components/gpu/fleet-overview'
import { profitShare, profitShareTotals } from '@/components/gpu/waterfall-view'

// For the page gates (sections 7 and 8): the caller's page access and the vehicle rows are the
// fixture; canViewPage and the resolver behind it are the real ones.
const s = vi.hoisted(() => ({ page: null as any, m: null as any }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m?.admin ?? {} }))
vi.mock('@/lib/supabase/server', () => ({ getUser: async () => ({ id: 'u' }) }))
vi.mock('@/lib/access/page-gate', async orig => ({
  ...(await orig<typeof import('@/lib/access/page-gate')>()),
  resolvePageAccess: async () => s.page,
}))
vi.mock('next/navigation', async orig => ({
  ...(await orig<typeof import('next/navigation')>()),
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
}))

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
        // An existing GPU SPV's subnav, filtered for THIS caller exactly as visibleChildrenFor does:
        // none of the four, so nothing GPU remains once the switch is off.
        const gpuKids = hrefs(fundsChildrenFor(SEG, false, 'gpu_spv').filter(k => canSee(k, isAdmin, bound(c))))
        for (const h of gpuHrefs(SEG)) expect(gpuKids).not.toContain(h)
      })
    }
  }

  it('visibleChildrenFor agrees on a GPU SPV with the switch off', () => {
    const funds = navSectionsFor(true, () => 'write').find(i => i.href === '/funds') as NavItem
    const kids = hrefs(visibleChildrenFor(funds, true, bound(CALLERS.admin), { fundSeg: SEG, kind: 'gpu_spv' }))
    for (const h of gpuHrefs(SEG)) expect(kids).not.toContain(h)
    expect(kids).toContain(`/funds/${SEG}/journal`)
  })
})

describe('1b. a GPU SPV\u2019s subnav per caller once gpu_fleet is on', () => {
  const on = { ...VC_FEATURES, gpu_fleet: 'everyone' } as FeatureVisibilityMap
  const kidsFor = (c: AccessContext) =>
    hrefs(fundsChildrenFor(SEG, false, 'gpu_spv').filter(k => canSee(k, c.role === 'admin', bound(c))))

  it('an admin sees all four', () => {
    const kids = kidsFor(ctx('admin', {}, on))
    for (const h of gpuHrefs(SEG)) expect(kids).toContain(h)
  })

  it('a member without the fleet grant keeps the waterfall and scenarios, loses fleet and revenue', () => {
    const kids = kidsFor(ctx('member', { accounting: 'read', fleet: 'none' }, on))
    expect(kids.filter(h => gpuHrefs(SEG).includes(h))).toEqual([`/funds/${SEG}/waterfall`, `/funds/${SEG}/scenarios`])
  })

  it('a fleet reader always holds lp_capital: the books imply it, and fleet requires the books', () => {
    // So a grant cannot drop the waterfall alone for someone who reads the fleet: lp_capital 'none'
    // is overridden by accounting read (DOMAIN_META.lp_capital.impliedBy). Only the fund's LP switch
    // takes it away, and the page itself checks that (section 8).
    const c = ctx('member', { accounting: 'read', fleet: 'read', lp_capital: 'none' }, on)
    expect(effectiveAccess(c, 'lp_capital')).toBe('read')
    const kids = kidsFor(c)
    for (const h of gpuHrefs(SEG)) expect(kids).toContain(h)
  })

  it('a member without the books sees none of the four', () => {
    const kids = kidsFor(ctx('member', { accounting: 'none', fleet: 'write' }, on))
    for (const h of gpuHrefs(SEG)) expect(kids).not.toContain(h)
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

  it('hasSectionForKind(\u2018fleet\u2019, \u2018fund\u2019) is false, so the firm-wide landing lists no VC entity', () => {
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

  it.each(ENTITY_PAGES)('%s calls requireVehicleAccess with kinds: [\u2018gpu_spv\u2019]', key => {
    expect(src(key)).toMatch(/requireVehicleAccess\([^)]*kinds:\s*\['gpu_spv'\]/)
    expect(PAGE_DOMAINS[key]?.gate).toBe('requireVehicleAccess')
  })

  it('the fleet register, asset detail and revenue also need the fleet grant behind gpu_fleet', () => {
    for (const key of ['funds/[id]/fleet', 'funds/[id]/fleet/[assetId]', 'funds/[id]/revenue']) {
      expect(src(key)).toMatch(/requireVehicleAccess\(params\.id, \{ domain: 'fleet', feature: 'gpu_fleet', kinds: \['gpu_spv'\] \}\)/)
      expect(PAGE_DOMAINS[key]).toEqual({ domain: 'fleet', feature: 'gpu_fleet', gate: 'requireVehicleAccess' })
    }
  })

  it('the waterfall needs investors\u2019 capital, behind gpu_fleet, and under lp_capital\u2019s own switch', () => {
    const page = src('funds/[id]/waterfall')
    expect(page).toMatch(/requireVehicleAccess\(params\.id, \{ domain: 'lp_capital', feature: 'gpu_fleet', kinds: \['gpu_spv'\] \}\)/)
    expect(page).toContain("if (!canViewPage(page, 'lp_capital')) redirect('/funds')")
    expect(PAGE_DOMAINS['funds/[id]/waterfall']).toEqual({ domain: 'lp_capital', feature: 'gpu_fleet', gate: 'requireVehicleAccess' })
  })

  it('scenarios need the books, behind gpu_fleet, and under accounting\u2019s own switch', () => {
    const page = src('funds/[id]/scenarios')
    expect(page).toMatch(/requireVehicleAccess\(params\.id, \{ feature: 'gpu_fleet', kinds: \['gpu_spv'\] \}\)/)
    expect(page).toContain("if (!canViewPage(page, 'accounting')) redirect('/funds')")
    expect(PAGE_DOMAINS['funds/[id]/scenarios']).toEqual({ domain: 'accounting', feature: 'gpu_fleet', gate: 'requireVehicleAccess' })
  })

  it('the lead page is the GPU one only behind fleet and gpu_fleet', () => {
    expect(src('funds/[id]')).toMatch(/isGpuSpv\(kind\) && vehicleId && canViewPage\(page, 'fleet', 'gpu_fleet'\)\s*\n\s*\? <GpuDetailView/)
  })

  it('/fleet has an error branch: a failed query is not an empty fleet', () => {
    const page = src('fleet')
    expect(page).toMatch(/const \{ data, error \} = await/)
    expect(page).toMatch(/\{error \? \([\s\S]*text-destructive[\s\S]*\) : \([\s\S]*<FleetOverview/)
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

  it('leaves every other kind\u2019s tabs as they were', () => {
    expect(forecastTabsFor('fund')).toEqual(['charts', 'investments', 'capital', 'financials'])
    expect(forecastTabsFor('manco')).toEqual(['charts', 'financials', 'capital'])
  })
})

describe('7. the firm-wide GPU landings (/funds/fleet, revenue, waterfall, scenarios)', () => {
  const APP = path.join(process.cwd(), 'app', '(app)')
  const section = (slug: string) => ACCOUNTING_SECTIONS.find(x => x.href === `/funds/${slug}`)!
  const asPage = (c: AccessContext) => ({ fundId: c.fundId, role: c.role, isAdmin: c.role === 'admin', access: c })
  const land = (slug: string) => requireGpuSectionAccess(section(slug))
  const on = { ...VC_FEATURES, gpu_fleet: 'everyone' } as FeatureVisibilityMap

  it('the landing page sends every GPU section through the GPU gate, and the gate asks for fleet behind gpu_fleet', () => {
    const page = readFileSync(path.join(APP, 'funds', '[id]', 'page.tsx'), 'utf8')
    expect(page).toMatch(/if \(section\?\.showFor\?\.includes\('gpu_spv'\)\) await requireGpuSectionAccess\(section\)\n\s*else await requireAccountingAccess\(\)/)
    const guard = readFileSync(path.join(APP, 'funds', 'guard.ts'), 'utf8')
    const helper = guard.slice(guard.indexOf('export async function requireGpuSectionAccess'))
    expect(helper).toMatch(/canViewPage\(page, 'fleet', 'gpu_fleet'\)[\s\S]*canViewPage\(page, section\.domain \?\? 'accounting'\)/)
  })

  it('an accounting-only member, gpu_fleet off: every landing redirects', async () => {
    s.page = asPage(ctx('member', { accounting: 'write' }))
    for (const slug of GPU_SLUGS) await expect(land(slug), slug).rejects.toThrow('NEXT_REDIRECT /funds')
  })

  it('gpu_fleet on, fleet read but no lp_capital: the waterfall redirects, the fleet renders', async () => {
    // Reading the books implies lp_capital (DOMAIN_META.lp_capital.impliedBy), and fleet requires the
    // books, so a grant alone cannot take lp_capital away. The fund-level LP switch can: `off` wins
    // over the implication.
    const noLps = { ...on, lps: 'off' } as FeatureVisibilityMap
    const member = ctx('member', { accounting: 'read', fleet: 'read', lp_capital: 'none' }, noLps)
    expect(effectiveAccess(member, 'fleet')).toBe('read')
    expect(effectiveAccess(member, 'lp_capital')).toBe('none')
    s.page = asPage(member)
    await expect(land('waterfall')).rejects.toThrow('NEXT_REDIRECT /funds')
    await expect(land('fleet')).resolves.toEqual({ fundId: 'f', role: 'member' })
    await expect(land('revenue')).resolves.toBeTruthy()
    await expect(land('scenarios')).resolves.toBeTruthy()
  })

  it('an admin with gpu_fleet on: all four render', async () => {
    s.page = asPage(ctx('admin', {}, on))
    for (const slug of GPU_SLUGS) await expect(land(slug), slug).resolves.toEqual({ fundId: 'f', role: 'admin' })
  })

  it('an admin with gpu_fleet off: all four redirect, admins included', async () => {
    s.page = asPage(ctx('admin', {}))
    for (const slug of GPU_SLUGS) await expect(land(slug), slug).rejects.toThrow('NEXT_REDIRECT /funds')
  })
})

describe('8. the GPU entity pages and /fleet, rendered through their real gates', () => {
  const GPU = '00000000-0000-4000-8000-0000000000bb'
  const on = { ...VC_FEATURES, gpu_fleet: 'everyone' } as FeatureVisibilityMap
  const asPage = (c: AccessContext) => ({ fundId: c.fundId, role: c.role, isAdmin: c.role === 'admin', access: c })
  const params = { params: Promise.resolve({ id: GPU }) }

  /** Every element type in a rendered tree (server pages return the tree; nothing is mounted). */
  const types = (node: any, out: any[] = []): any[] => {
    if (Array.isArray(node)) { for (const n of node) types(n, out); return out }
    if (node && typeof node === 'object' && 'type' in node) { out.push(node.type); types(node.props?.children, out) }
    return out
  }
  const text = (node: any): string =>
    Array.isArray(node) ? node.map(text).join('')
      : typeof node === 'string' ? node
        : node && typeof node === 'object' && 'props' in node ? text(node.props?.children) : ''

  beforeEach(() => {
    s.m = memoryAdmin({ fund_vehicles: [{ id: GPU, fund_id: 'f', name: 'H200 SPV I', kind: 'gpu_spv', active: true }] })
  })

  it('a GPU SPV\u2019s lead page is the GPU page with gpu_fleet on', async () => {
    s.page = asPage(ctx('admin', {}, on))
    const tree = await EntityPage({ ...params, searchParams: Promise.resolve({}) })
    expect(types(tree)).toContain(GpuDetailView)
    expect(types(tree)).not.toContain(FundDetailView)
  })

  it('and the plain fund lead page with gpu_fleet off, admins included', async () => {
    s.page = asPage(ctx('admin', {}))
    const tree = await EntityPage({ ...params, searchParams: Promise.resolve({}) })
    expect(types(tree)).toContain(FundDetailView)
    expect(types(tree)).not.toContain(GpuDetailView)
  })

  it('waterfall and scenarios redirect with gpu_fleet off, admins included', async () => {
    s.page = asPage(ctx('admin', {}))
    await expect(WaterfallPage(params)).rejects.toThrow('NEXT_REDIRECT /dashboard')
    await expect(ScenariosPage(params)).rejects.toThrow('NEXT_REDIRECT /dashboard')
  })

  it('both render for an admin with gpu_fleet on', async () => {
    s.page = asPage(ctx('admin', {}, on))
    await expect(WaterfallPage(params)).resolves.toBeTruthy()
    await expect(ScenariosPage(params)).resolves.toBeTruthy()
  })

  it('the waterfall also asks lp_capital under its own switch: LP Reporting off refuses it', async () => {
    s.page = asPage(ctx('admin', {}, { ...on, lps: 'off' } as FeatureVisibilityMap))
    await expect(WaterfallPage(params)).rejects.toThrow('NEXT_REDIRECT /funds')
    await expect(ScenariosPage(params)).resolves.toBeTruthy()
  })

  it('/fleet lists the GPU SPVs on a good query', async () => {
    s.page = asPage(ctx('admin', {}, on))
    const tree = await FleetOverviewPage()
    expect(types(tree)).toContain(FleetOverview)
  })

  it('/fleet says a failed query failed, rather than showing an empty fleet', async () => {
    s.page = asPage(ctx('admin', {}, on))
    s.m.failNext('fund_vehicles', 'select', 'connection reset')
    const tree = await FleetOverviewPage()
    expect(types(tree)).not.toContain(FleetOverview)
    expect(text(tree)).toContain('Could not load the GPU SPVs')
  })
})

describe('9. the waterfall\u2019s profit share is what was PAID, beside what was declared (Q8)', () => {
  const row = (carry: { amount: number; settled: number }[]) => ({
    carryTotal: carry.reduce((t, l) => t + l.amount, 0),
    lines: [
      { role: 'lp' as const, amount: 80_000, settled: 80_000 },
      ...carry.map(l => ({ role: 'carry' as const, ...l })),
    ],
  })

  it('unpaid: declared, nothing paid', () => {
    expect(profitShare(row([{ amount: 20_000, settled: 0 }]))).toEqual({ paid: 0, declared: 20_000 })
  })

  it('part paid: only what settled, across carry lines, LP lines ignored', () => {
    expect(profitShare(row([{ amount: 12_000, settled: 5_000.25 }, { amount: 8_000, settled: 0 }]))).toEqual({ paid: 5_000.25, declared: 20_000 })
  })

  it('fully paid', () => {
    expect(profitShare(row([{ amount: 20_000, settled: 20_000 }]))).toEqual({ paid: 20_000, declared: 20_000 })
  })

  it('cumulative tiles sum each', () => {
    expect(profitShareTotals([row([{ amount: 20_000, settled: 0 }]), row([{ amount: 10_000, settled: 10_000 }])]))
      .toEqual({ paid: 10_000, declared: 30_000 })
  })
})
