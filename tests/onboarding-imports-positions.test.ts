import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The LP positions import must leave the vehicle with partners accounting can see.
 *
 * It wrote lp_positions + commitment_events but no lp_investments, while vehicleStatus,
 * opening balances and allocation all find partners through lp_investments — so an importer-only
 * fund read "No partners yet". Pinned here: rows are created, never duplicated or overwritten on
 * re-import, and never inserted into a report shared with investors.
 */

const getUser = vi.hoisted(() => vi.fn())
const parseLpData = vi.hoisted(() => vi.fn())
const ensureCapitalAccounts = vi.hoisted(() => vi.fn(async () => new Map()))

// --- a tiny in-memory Supabase ---------------------------------------------------------------
type Row = Record<string, any>
let db: Record<string, Row[]> = {}

function query(table: string) {
  const filters: ((r: Row) => boolean)[] = []
  let order: { col: string; asc: boolean } | null = null
  let limitN: number | null = null
  let head = false
  const rows = () => {
    let out = (db[table] ?? []).filter(r => filters.every(f => f(r)))
    if (order) {
      const { col, asc } = order
      out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1))
    }
    if (limitN != null) out = out.slice(0, limitN)
    return out
  }
  const result = () => head ? { data: null, count: rows().length, error: null } : { data: rows(), error: null }
  const chain: any = {
    select: (_c?: string, opts?: { head?: boolean }) => { head = !!opts?.head; return chain },
    eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return chain },
    in: (c: string, v: unknown[]) => { filters.push(r => v.includes(r[c])); return chain },
    order: (col: string, o?: { ascending?: boolean }) => { order = { col, asc: o?.ascending !== false }; return chain },
    limit: (n: number) => { limitN = n; return chain },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => resolve(result()),
    insert: (input: Row | Row[]) => {
      const list = Array.isArray(input) ? input : [input]
      if (table === 'lp_investments') {
        // The shared-report lock, as the trigger enforces it.
        for (const r of list) {
          if (r.snapshot_id && (db.lp_snapshot_shares ?? []).some(s => s.snapshot_id === r.snapshot_id)) {
            return Promise.resolve({ data: null, error: { message: 'This report is shared with investors.' } })
          }
        }
      }
      ;(db[table] ??= []).push(...list.map(r => ({ ...r })))
      return Promise.resolve({ data: null, error: null })
    },
    update: () => { throw new Error(`unexpected update on ${table}`) },
    delete: () => {
      const d: any = {
        eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return d },
        in: (c: string, v: unknown[]) => { filters.push(r => v.includes(r[c])); return d },
        then: (resolve: (v: unknown) => void) => {
          const gone = new Set(rows())
          db[table] = (db[table] ?? []).filter(r => !gone.has(r))
          resolve({ error: null })
        },
      }
      return d
    },
  }
  return chain
}
const admin = { from: (t: string) => query(t) }

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => admin }))
vi.mock('@/lib/api-helpers', () => ({ assertWriteAccess: async () => ({ fundId: 'fund-1', role: 'admin', userId: 'u-1', need: 'write' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async () => 'Fund I' }))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'veh-1' }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/accounting/persist', () => ({ ensureCapitalAccounts }))
vi.mock('@/lib/lp-import/parse', async (orig) => {
  const real = await orig<typeof import('@/lib/lp-import/parse')>()
  return {
    ...real,
    parseLpData,
    loadEntityCaches: async () => ({ investorByName: new Map(), entityByName: new Map(), entityInvestor: new Map() }),
    resolveOrCreateEntity: async (_a: unknown, _f: string, _i: string, entityName: string) => `ent-${entityName.toLowerCase().replace(/\s+/g, '-')}`,
  }
})

import { POST } from '@/app/api/accounting/positions/import/route'
import { ensureVehicleInvestments } from '@/lib/lp-import/ensure-investments'

const req = (body: Record<string, unknown>) => ({ json: async () => body, nextUrl: { searchParams: new URLSearchParams() } }) as any
const paste = (asOfDate = '2026-06-30') => POST(req({ group: 'Fund I', asOfDate, data: 'Investor,Commitment\n...' }))

beforeEach(() => {
  vi.clearAllMocks()
  db = {}
  getUser.mockResolvedValue({ data: { user: { id: 'u-1' } } })
  parseLpData.mockResolvedValue([
    { investor_name: 'Example LP 1', portfolio_group: 'Fund I', commitment: 1_000_000, called_capital: 250_000, nav: 240_000 },
    { investor_name: 'Example LP 2', entity_name: 'Example LP 2 Trust', portfolio_group: 'Fund I', commitment: 500_000, called_capital: 125_000 },
  ])
})

describe('POST /api/accounting/positions/import — partners for accounting', () => {
  it('creates an lp_investments row per imported entity, under the vehicle name', async () => {
    const res = await paste()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.partnersCreated).toBe(2)
    expect(db.lp_investments).toEqual([
      { fund_id: 'fund-1', entity_id: 'ent-example-lp-1', portfolio_group: 'Fund I', commitment: 1_000_000, snapshot_id: null },
      { fund_id: 'fund-1', entity_id: 'ent-example-lp-2-trust', portfolio_group: 'Fund I', commitment: 500_000, snapshot_id: null },
    ])
    expect(ensureCapitalAccounts).toHaveBeenCalledWith(admin, 'fund-1', 'Fund I', ['ent-example-lp-1', 'ent-example-lp-2-trust'])
  })

  it('is idempotent: a re-import (even with a new commitment) neither duplicates nor overwrites', async () => {
    await paste()
    parseLpData.mockResolvedValue([{ investor_name: 'Example LP 1', portfolio_group: 'Fund I', commitment: 2_000_000 }])
    const res = await paste('2026-09-30')
    expect((await res.json()).partnersCreated).toBe(0)
    expect(db.lp_investments).toHaveLength(2)
    expect(db.lp_investments[0].commitment).toBe(1_000_000)
  })

  it('seeds a new row from the latest dated commitment, not a back-dated paste', async () => {
    db.lp_positions = [{ fund_id: 'fund-1', vehicle_id: 'veh-1', lp_entity_id: 'ent-example-lp-1', as_of_date: '2026-12-31', commitment: 1_500_000 }]
    parseLpData.mockResolvedValue([{ investor_name: 'Example LP 1', portfolio_group: 'Fund I', commitment: 1_000_000 }])
    await paste('2026-03-31')
    expect(db.lp_investments).toEqual([expect.objectContaining({ entity_id: 'ent-example-lp-1', commitment: 1_500_000 })])
  })

  it('attaches to the latest report when it is not shared', async () => {
    db.lp_snapshots = [
      { id: 'snap-old', fund_id: 'fund-1', created_at: '2026-01-01' },
      { id: 'snap-new', fund_id: 'fund-1', created_at: '2026-07-01' },
    ]
    await paste()
    expect(db.lp_investments.every(r => r.snapshot_id === 'snap-new')).toBe(true)
  })

  it('never inserts into a report shared with investors', async () => {
    db.lp_snapshots = [{ id: 'snap-new', fund_id: 'fund-1', created_at: '2026-07-01' }]
    db.lp_snapshot_shares = [{ id: 'share-1', fund_id: 'fund-1', snapshot_id: 'snap-new' }]
    const res = await paste()
    const body = await res.json()
    expect(body.errors).toEqual([])
    expect(db.lp_investments.every(r => r.snapshot_id === null)).toBe(true)
  })
})

describe('ensureVehicleInvestments', () => {
  it('treats a row in any report as existing, and creates nothing for an empty set', async () => {
    db.lp_investments = [{ fund_id: 'fund-1', entity_id: 'e1', portfolio_group: 'Fund I', snapshot_id: 'snap-x', commitment: 10 }]
    expect(await ensureVehicleInvestments(admin as any, 'fund-1', 'Fund I', new Map([['e1', 99]]))).toEqual({ created: 0, snapshotId: null })
    expect(await ensureVehicleInvestments(admin as any, 'fund-1', 'Fund I', new Map())).toEqual({ created: 0, snapshotId: null })
    expect(db.lp_investments).toHaveLength(1)
  })

  it('scopes the existence check to the vehicle: the same entity in another vehicle still gets a row', async () => {
    db.lp_investments = [{ fund_id: 'fund-1', entity_id: 'e1', portfolio_group: 'Fund II', snapshot_id: null, commitment: 10 }]
    const out = await ensureVehicleInvestments(admin as any, 'fund-1', 'Fund I', new Map([['e1', null]]))
    expect(out.created).toBe(1)
    expect(db.lp_investments[1]).toMatchObject({ entity_id: 'e1', portfolio_group: 'Fund I', commitment: 0 })
  })
})
