import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'

/**
 * The books' audit trail is gated on `accounting` read, but its events straddle other domains: a
 * management company's ledger (management_company), staged Analyst actions of ANY domain (their
 * full args ride along in details), and the tax module (accounting + tax_reporting).
 */

let access: any
const events = vi.hoisted(() => ({ rows: [] as any[] }))
const vehicles = [
  { id: 'v-fund', name: 'Fund I', kind: 'fund' },
  { id: 'v-manco', name: 'Hemrock Management', kind: 'manco' },
]

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }),
}))

function query(table: string) {
  const filters: [string, unknown][] = []
  const q: any = {
    select: () => q,
    eq: (col: string, v: unknown) => { filters.push([col, v]); return q },
    gte: () => q, lte: () => q, order: () => q,
    contains: () => q,
    range: async () => {
      const rows = events.rows.filter(r => filters.every(([c, v]) => c === 'fund_id' || r[c] === v))
      return { data: rows, error: null }
    },
    maybeSingle: async () => {
      const name = filters.find(([c]) => c === 'name')?.[1]
      return { data: vehicles.find(v => v.name === name) ?? null, error: null }
    },
    then: (res: any) => res(table === 'fund_vehicles' ? { data: vehicles, error: null } : { data: [], error: null }),
  }
  return q
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (t: string) => query(t),
    auth: { admin: { getUserById: async () => ({ data: { user: null } }) } },
  }),
}))
vi.mock('@/lib/api-helpers', () => ({
  assertReadAccess: async () => ({ fundId: 'f', role: 'member' }),
}))
vi.mock('@/lib/access/effective', async orig => ({
  ...(await orig<typeof import('@/lib/access/effective')>()),
  loadAccessContext: async () => access,
}))
vi.mock('@/lib/accounting/vehicle-resolver', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/vehicle-resolver')>()),
  resolveVehicle: async (_a: unknown, _f: string, requested: string) => {
    const v = vehicles.find(x => x.name === requested)
    if (!v) {
      const { VehicleResolutionError } = await orig<typeof import('@/lib/accounting/vehicle-resolver')>()
      throw new VehicleResolutionError(`Unknown vehicle "${requested}"`)
    }
    return v.name
  },
}))
vi.mock('@/lib/accounting/vehicle-id', () => ({
  vehicleIdByName: async (_a: unknown, _f: string, name: string) => vehicles.find(v => v.name === name)?.id ?? null,
}))

import { GET } from '@/app/api/accounting/audit-log/route'
import { visibleTo } from '@/lib/audit/read'

function ctx(grants: Record<string, string>, features: Record<string, string> = {}) {
  return {
    fundId: 'f', userId: 'u', role: 'member',
    features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', management_company: 'everyone', ...features },
    grants, defaults: {}, vehicles: { all: true, ids: [] },
  } as any
}

const ev = (id: string, action: string, vehicle_id: string | null, details: Record<string, unknown> = {}) => ({
  id, created_at: '2026-10-01T00:00:00Z', action, subject_type: 'x', subject_id: null, vehicle_id, actor_id: null, reason: null, details,
})

const get = (qs = '') => GET(new NextRequest(`http://localhost/api/accounting/audit-log${qs}`))

beforeEach(() => {
  events.rows = [
    ev('fund-void', 'entry.void', 'v-fund'),
    ev('manco-void', 'entry.void', 'v-manco', { memo: 'Payroll — CEO salary' }),
    ev('tax', 'tax.adjustments', 'v-fund'),
    ev('pa-portfolio', 'pending_action.approve', 'v-fund', { actionType: 'update_company_metric', args: { value: 1 } }),
    ev('pa-accounting', 'pending_action.approve', 'v-fund', { actionType: 'update_portfolio_construction', args: {} }),
    ev('pa-unknown', 'pending_action.reject', 'v-fund', { actionType: 'no_such_action', args: {} }),
  ]
})

describe('visibleTo — straddling events', () => {
  it('pending_action.* follows the staged action\'s own domain; unknown types are hidden', () => {
    const books = visibleTo(ctx({ accounting: 'read' }))
    expect(books('pending_action.approve', { actionType: 'update_company_metric' })).toBe(false)
    expect(books('pending_action.approve', { actionType: 'no_such_action' })).toBe(false)
    expect(books('pending_action.approve', {})).toBe(false)
    expect(books('pending_action.approve')).toBe(false)
    const both = visibleTo(ctx({ accounting: 'read', portfolio: 'read' }))
    expect(both('pending_action.approve', { actionType: 'update_company_metric' })).toBe(true)
  })

  it('tax.* needs accounting with the tax_reporting feature on', () => {
    expect(visibleTo(ctx({ accounting: 'read' }, { tax_reporting: 'off' }))('tax.adjustments')).toBe(false)
    expect(visibleTo(ctx({ accounting: 'read' }, { tax_reporting: 'everyone' }))('tax.adjustments')).toBe(true)
  })
})

describe('GET /api/accounting/audit-log', () => {
  it('refuses ?group= naming a management company without the management_company grant', async () => {
    access = ctx({ accounting: 'read' })
    const res = await get('?group=Hemrock%20Management')
    expect(res.status).toBe(403)
    const csv = await get('?group=Hemrock%20Management&format=csv')
    expect(csv.status).toBe(403)
  })

  it('serves the manco to a caller who holds management_company', async () => {
    access = ctx({ accounting: 'read', management_company: 'read' })
    const res = await get('?group=Hemrock%20Management')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.events.map((e: any) => e.id)).toEqual(['manco-void'])
  })

  it('drops manco, tax and other-domain staged-action events from the firm-wide trail (JSON and CSV)', async () => {
    access = ctx({ accounting: 'read' })
    const body = await (await get()).json()
    expect(body.events.map((e: any) => e.id).sort()).toEqual(['fund-void', 'pa-accounting'])

    const csv = await (await get('?format=csv')).text()
    expect(csv).not.toContain('Payroll')
    expect(csv).not.toContain('tax.adjustments')
    expect(csv).not.toContain('update_company_metric')
    expect(csv).not.toContain('no_such_action')
    expect(csv).toContain('entry.void')
  })

  it('a caller with every grant sees everything except the unknown action type', async () => {
    access = ctx({ accounting: 'read', management_company: 'read', portfolio: 'read' }, { tax_reporting: 'everyone' })
    const body = await (await get()).json()
    expect(body.events.map((e: any) => e.id).sort()).toEqual(['fund-void', 'manco-void', 'pa-accounting', 'pa-portfolio', 'tax'])
  })
})
