import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'

/**
 * The (app) layout runs on every page render, so each sequential await in it is a round trip on
 * every navigation. It used to wait for the first batch, then the user's own membership, then the
 * scoped counts, then the approvals count, then the admin-only lookups — four stages after the
 * first. Now the approvals count joins the first batch, and the admin lookups run alongside the
 * membership read, so the only remaining dependency is scopedCounts on ownMembership.
 *
 * Every query and cached read here logs when it starts and when it settles (on a timer, so
 * siblings in one Promise.all genuinely overlap); the ordering assertions read that log. The
 * props AppShell receives are pinned per role so the restructure cannot change what renders.
 */

let log: string[] = []
let role: 'admin' | 'member' = 'admin'
let ownMembership: Record<string, unknown> | null = null

const settle = <T,>(name: string, value: T): Promise<T> => {
  log.push(`start:${name}`)
  return new Promise(resolve => setTimeout(() => { log.push(`end:${name}`); resolve(value) }, 0))
}

const RESULTS: Record<string, () => unknown> = {
  funds: () => ({ data: { id: 'fund-1' } }),
  fund_members: () => ({ data: ownMembership }),
  fund_vehicles: () => ({ count: 0 }),
  parsing_reviews: () => ({ count: 3 }),
  inbound_emails: () => ({ count: 4 }),
  pending_actions: () => ({ count: 2 }),
}

function query(table: string) {
  const builder: any = {}
  for (const m of ['select', 'eq', 'is', 'limit', 'single', 'maybeSingle']) builder[m] = () => builder
  builder.then = (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
    settle(table, RESULTS[table]()).then(ok, fail)
  return builder
}

vi.mock('next/headers', () => ({ headers: async () => new Map() }))
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`redirect ${to}`) } }))
vi.mock('next/script', () => ({ default: () => null }))
vi.mock('@/components/app-shell', () => ({ AppShell: () => null }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: query }),
  getUser: async () => ({ id: 'user-1', email: 'me@fund.test' }),
}))
vi.mock('@/lib/cache/layout', () => ({
  getFundData: () => settle('getFundData', { id: 'fund-1', name: 'Laconia Capital', logo_url: null }),
  getMembership: () => settle('getMembership', { role }),
  getFundSettings: () => settle('getFundSettings', {
    currency: 'EUR',
    default_ai_provider: 'openai',
    feature_visibility: { deals: 'everyone' },
    lp_portal_enabled: false,
  }),
  getReviewBadge: () => settle('getReviewBadge', 9),
  getNotesBadge: () => settle('getNotesBadge', 1),
  getDomainGrants: () => settle('getDomainGrants', { grants: [{ domain: 'dealflow', level: 'write' }], defaults: [{ domain: 'portfolio', level: 'read' }] }),
  getFofActive: () => settle('getFofActive', false),
  getPendingRequests: () => settle('getPendingRequests', 5),
  getUpdateAvailable: () => settle('getUpdateAvailable', true),
}))

import AppLayout from '@/app/(app)/layout'
import { AppShell } from '@/components/app-shell'

function findShell(node: ReactNode): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findShell(child); if (hit) return hit }
    return null
  }
  if (!isValidElement(node)) return null
  const el = node as ReactElement<Record<string, unknown>>
  if (el.type === AppShell) return el
  return findShell(el.props.children as ReactNode)
}

async function render() {
  const tree = await AppLayout({ children: 'page' })
  const shell = findShell(tree)
  if (!shell) throw new Error('AppShell not rendered')
  const { children, ...props } = shell.props
  const banner = Array.isArray(children) && children.some(c => isValidElement(c))
  return { ...props, banner }
}

const at = (entry: string) => {
  const i = log.indexOf(entry)
  if (i < 0) throw new Error(`${entry} never happened: ${log.join(', ')}`)
  return i
}

beforeEach(() => {
  log = []
  ownMembership = null
})

describe('the (app) layout', () => {
  it('passes AppShell the same props for an admin', async () => {
    role = 'admin'
    expect(await render()).toMatchInlineSnapshot(`
      {
        "approvalsBadge": 2,
        "banner": false,
        "configuredProviders": [],
        "currency": "EUR",
        "defaultAIProvider": "openai",
        "domainAccess": {
          "defaults": {
            "portfolio": "read",
          },
          "features": {
            "accounting": "off",
            "asks": "admin",
            "compliance": "off",
            "deals": "everyone",
            "diligence": "off",
            "gp_economics": "off",
            "imports": "everyone",
            "interactions": "off",
            "investments": "everyone",
            "lp_activity": "hidden",
            "lp_letters": "off",
            "lp_portal": "hidden",
            "lp_tracking": "off",
            "lps": "off",
            "management_company": "off",
            "notes": "off",
            "tax_reporting": "off",
          },
          "grants": {
            "dealflow": "write",
          },
          "role": "admin",
        },
        "featureVisibility": {
          "accounting": "off",
          "asks": "admin",
          "compliance": "off",
          "deals": "everyone",
          "diligence": "off",
          "gp_economics": "off",
          "imports": "everyone",
          "interactions": "off",
          "investments": "everyone",
          "lp_activity": "hidden",
          "lp_letters": "off",
          "lp_portal": "hidden",
          "lp_tracking": "off",
          "lps": "off",
          "management_company": "off",
          "notes": "off",
          "tax_reporting": "off",
        },
        "fofActive": false,
        "fundLogo": null,
        "fundName": "Laconia Capital",
        "hasAIKey": false,
        "isAdmin": true,
        "lpPortalEnabled": false,
        "notesBadge": 1,
        "reviewBadge": 9,
        "settingsBadge": 5,
        "updateAvailable": true,
        "userEmail": "me@fund.test",
      }
    `)
  })

  it('passes AppShell the same props for a member with all entities', async () => {
    role = 'member'
    ownMembership = { role: 'member', all_entities: true }
    expect(await render()).toMatchInlineSnapshot(`
      {
        "approvalsBadge": 2,
        "banner": false,
        "configuredProviders": [],
        "currency": "EUR",
        "defaultAIProvider": "openai",
        "domainAccess": {
          "defaults": {
            "portfolio": "read",
          },
          "features": {
            "accounting": "off",
            "asks": "admin",
            "compliance": "off",
            "deals": "everyone",
            "diligence": "off",
            "gp_economics": "off",
            "imports": "everyone",
            "interactions": "off",
            "investments": "everyone",
            "lp_activity": "hidden",
            "lp_letters": "off",
            "lp_portal": "hidden",
            "lp_tracking": "off",
            "lps": "off",
            "management_company": "off",
            "notes": "off",
            "tax_reporting": "off",
          },
          "grants": {
            "dealflow": "write",
          },
          "role": "member",
        },
        "featureVisibility": {
          "accounting": "off",
          "asks": "admin",
          "compliance": "off",
          "deals": "everyone",
          "diligence": "off",
          "gp_economics": "off",
          "imports": "everyone",
          "interactions": "off",
          "investments": "everyone",
          "lp_activity": "hidden",
          "lp_letters": "off",
          "lp_portal": "hidden",
          "lp_tracking": "off",
          "lps": "off",
          "management_company": "off",
          "notes": "off",
          "tax_reporting": "off",
        },
        "fofActive": false,
        "fundLogo": null,
        "fundName": "Laconia Capital",
        "hasAIKey": false,
        "isAdmin": false,
        "lpPortalEnabled": false,
        "notesBadge": 1,
        "reviewBadge": 9,
        "settingsBadge": 0,
        "updateAvailable": false,
        "userEmail": "me@fund.test",
      }
    `)
  })

  it('passes AppShell the same props, and the no-entities banner, for a scoped member', async () => {
    role = 'member'
    ownMembership = { role: 'member', all_entities: false }
    expect(await render()).toMatchInlineSnapshot(`
      {
        "approvalsBadge": 2,
        "banner": true,
        "configuredProviders": [],
        "currency": "EUR",
        "defaultAIProvider": "openai",
        "domainAccess": {
          "defaults": {
            "portfolio": "read",
          },
          "features": {
            "accounting": "off",
            "asks": "admin",
            "compliance": "off",
            "deals": "everyone",
            "diligence": "off",
            "gp_economics": "off",
            "imports": "everyone",
            "interactions": "off",
            "investments": "everyone",
            "lp_activity": "hidden",
            "lp_letters": "off",
            "lp_portal": "hidden",
            "lp_tracking": "off",
            "lps": "off",
            "management_company": "off",
            "notes": "off",
            "tax_reporting": "off",
          },
          "grants": {
            "dealflow": "write",
          },
          "role": "member",
        },
        "featureVisibility": {
          "accounting": "off",
          "asks": "admin",
          "compliance": "off",
          "deals": "everyone",
          "diligence": "off",
          "gp_economics": "off",
          "imports": "everyone",
          "interactions": "off",
          "investments": "everyone",
          "lp_activity": "hidden",
          "lp_letters": "off",
          "lp_portal": "hidden",
          "lp_tracking": "off",
          "lps": "off",
          "management_company": "off",
          "notes": "off",
          "tax_reporting": "off",
        },
        "fofActive": false,
        "fundLogo": null,
        "fundName": "Laconia Capital",
        "hasAIKey": false,
        "isAdmin": false,
        "lpPortalEnabled": false,
        "notesBadge": 1,
        "reviewBadge": 7,
        "settingsBadge": 0,
        "updateAvailable": false,
        "userEmail": "me@fund.test",
      }
    `)
  })

  it('counts approvals in the first batch, not after it', async () => {
    for (const r of ['admin', 'member'] as const) {
      log = []
      role = r
      ownMembership = r === 'member' ? { role: 'member', all_entities: false } : null
      await render()
      // Started before any of the first batch settled: it is in that Promise.all.
      expect(at('start:pending_actions')).toBeLessThan(at('end:getFundData'))
      expect(at('start:pending_actions')).toBeLessThan(at('end:getMembership'))
    }
  })

  it("runs an admin's join-request count and update check together, straight after the first batch", async () => {
    role = 'admin'
    await render()
    const firstBatchDone = Math.max(at('end:getMembership'), at('end:pending_actions'))
    for (const name of ['getPendingRequests', 'getUpdateAvailable']) {
      expect(at(`start:${name}`)).toBeGreaterThan(firstBatchDone)
      // Both invoked before either settles: one stage, not two.
      expect(at(`start:${name}`)).toBeLessThan(Math.min(at('end:getPendingRequests'), at('end:getUpdateAvailable')))
    }
    // An admin never reads their own membership row or the scoped counts.
    expect(log).not.toContain('start:fund_members')
    expect(log).not.toContain('start:fund_vehicles')
  })

  it("reads a scoped member's counts only after their membership row, and nothing after that", async () => {
    role = 'member'
    ownMembership = { role: 'member', all_entities: false }
    await render()
    for (const t of ['fund_vehicles', 'parsing_reviews', 'inbound_emails']) {
      expect(at(`start:${t}`)).toBeGreaterThan(at('end:fund_members'))
    }
    expect(log).not.toContain('start:getPendingRequests')
    expect(log).not.toContain('start:getUpdateAvailable')
    // The scoped counts are the last stage.
    const last = Math.max(at('end:fund_vehicles'), at('end:parsing_reviews'), at('end:inbound_emails'))
    expect(log.slice(last + 1).filter(e => e.startsWith('start:'))).toEqual([])
  })
})
