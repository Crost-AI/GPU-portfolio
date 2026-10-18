import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { GPU_SPV_CHART } from '@/lib/accounting/chart'

// ── GPU fleet (P3) ── The manual operations routes. The middleware's `fleet` gate and the entity
// scope (resolveGroupWithAccess) are stubbed; what is under test is each handler's own refusals:
// a vehicle that is not a GPU SPV is not found, and posting or matching needs accounting write.

const s = vi.hoisted(() => ({ m: null as any, accountingWrite: true }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async orig => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member', need: 'write' }), assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member', need: 'read' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupWithAccess: async (_a: unknown, _g: unknown, requested: string | null) => ({ group: requested ?? 'GPU I', access: {} }) }))
vi.mock('@/lib/access/effective', async orig => ({
  ...(await orig<any>()),
  hasAccess: (_ctx: unknown, domain: string, need: string) => !(domain === 'accounting' && need === 'write') || s.accountingWrite,
}))
vi.mock('@/lib/accounting/persist', async orig => ({
  ...(await orig<any>()),
  persistEntry: vi.fn(async (_a: any, fundId: string, _g: string, _u: string, entry: any) => {
    const t = s.m.tables
    const id = `je-${t.journal_entries.length + 1}`
    t.journal_entries.push({ id, fund_id: fundId, vehicle_id: 'v-gpu', book: 'actual', status: 'posted', entry_date: entry.entryDate, source_ref: entry.sourceRef })
    return { entryId: id }
  }),
}))

import { POST as importPost } from '@/app/api/fleet/ops/import/route'
import { GET as earningsGet, POST as earningsPost } from '@/app/api/fleet/ops/earnings/route'
import { GET as payoutsGet, POST as payoutsPost } from '@/app/api/fleet/ops/payouts/route'
import { GET as kpisGet } from '@/app/api/fleet/kpis/route'

const req = (url: string, body?: object) =>
  new NextRequest(`http://localhost${url}`, body ? { method: 'POST', body: JSON.stringify(body) } : { method: 'GET' })
const CSV = 'H200 #1,2026-09-01,2026-09-30,4320,,8640,864,7776\nH200 #2,2026-09-01,2026-09-30,,50,5000,500,4500\nGhost,2026-09-01,2026-09-30,1,,1'

beforeEach(() => {
  s.accountingWrite = true
  s.m = memoryAdmin({
    fund_vehicles: [
      { id: 'v-gpu', fund_id: 'f', name: 'GPU I', kind: 'gpu_spv', aliases: [] },
      { id: 'v-fund', fund_id: 'f', name: 'Fund I', kind: 'fund', aliases: [] },
    ],
    chart_of_accounts: GPU_SPV_CHART.map(a => ({ id: `acc-${a.code}`, fund_id: 'f', vehicle_id: 'v-gpu', code: a.code, name: a.name, type: a.type })),
    gpu_asset_types: [{ id: 't-1', fund_id: 'f', code: 'h200' }],
    gpu_assets: [1, 2].map(n => ({ id: `a-${n}`, fund_id: 'f', vehicle_id: 'v-gpu', asset_type_id: 't-1', name: `H200 #${n}`, serials: [], gpu_count: 8, status: 'in_service', in_service_date: '2026-01-01', disposed_on: null })),
    gpu_import_runs: [], gpu_earnings: [], gpu_payouts: [], journal_entries: [], journal_postings: [], bank_transactions: [],
  })
})

describe('a vehicle that is not a GPU SPV is not found, on every route', () => {
  it.each<[string, () => Promise<Response>]>([
    ['POST import', () => importPost(req('/api/fleet/ops/import', { group: 'Fund I', csv: CSV }))],
    ['GET earnings', () => earningsGet(req('/api/fleet/ops/earnings?group=Fund%20I'))],
    ['POST earnings', () => earningsPost(req('/api/fleet/ops/earnings', { group: 'Fund I', action: 'post', ids: [] }))],
    ['GET payouts', () => payoutsGet(req('/api/fleet/ops/payouts?group=Fund%20I'))],
    ['POST payouts', () => payoutsPost(req('/api/fleet/ops/payouts', { group: 'Fund I', action: 'record', date: '2026-10-01', amount: 1 }))],
    ['GET kpis', () => kpisGet(req('/api/fleet/kpis?group=Fund%20I&month=2026-09'))],
  ])('%s → 404, nothing written', async (_, call) => {
    const res = await call()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Vehicle not found' })
    expect(s.m.tables.gpu_earnings).toEqual([])
    expect(s.m.tables.gpu_payouts).toEqual([])
  })
})

describe('POST /api/fleet/ops/import and GET /api/fleet/ops/earnings', () => {
  it('stages a paste and lists it, newest period first then by server', async () => {
    const res = await importPost(req('/api/fleet/ops/import', { group: 'GPU I', csv: CSV, fileName: 'sept.csv' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ imported: 3, matched: 2, skipped: 0, runId: expect.any(String) })
    expect(body.staged).toHaveLength(3)

    const list = await (await earningsGet(req('/api/fleet/ops/earnings?group=GPU%20I'))).json()
    expect(list.rows.map((r: any) => [r.assetName ?? r.assetRef, r.status])).toEqual([['Ghost', 'unmatched'], ['H200 #1', 'staged'], ['H200 #2', 'staged']])
    expect(list.rows[2]).toMatchObject({ assetId: 'a-2', gpuHoursRented: 2880, utilizationPct: 50, gross: 5000, fee: 500, net: 4500, entryId: null, supersedesId: null })
    expect((await (await earningsGet(req('/api/fleet/ops/earnings?group=GPU%20I&status=unmatched'))).json()).rows).toHaveLength(1)
    expect((await earningsGet(req('/api/fleet/ops/earnings?group=GPU%20I&status=bogus'))).status).toBe(400)
  })

  it('refuses a body with neither rows nor csv', async () => {
    expect((await importPost(req('/api/fleet/ops/import', { group: 'GPU I' }))).status).toBe(400)
  })
})

describe('POST /api/fleet/ops/earnings', () => {
  const stage = async () => {
    await importPost(req('/api/fleet/ops/import', { group: 'GPU I', csv: CSV }))
    return s.m.tables.gpu_earnings.filter((e: any) => e.status === 'staged').map((e: any) => e.id)
  }

  it('post without accounting write → 403 naming the grant, nothing posted', async () => {
    const ids = await stage()
    s.accountingWrite = false
    const res = await earningsPost(req('/api/fleet/ops/earnings', { group: 'GPU I', action: 'post', ids }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Posting revenue needs write access to Fund accounting.' })
    expect(s.m.tables.journal_entries).toEqual([])
  })

  it('ignore needs only fleet write; post books the rows', async () => {
    const ids = await stage()
    s.accountingWrite = false
    const ghost = s.m.tables.gpu_earnings.find((e: any) => e.status === 'unmatched').id
    expect(await (await earningsPost(req('/api/fleet/ops/earnings', { group: 'GPU I', action: 'ignore', ids: [ghost] }))).json()).toEqual({ ignored: [ghost] })
    s.accountingWrite = true
    const res = await earningsPost(req('/api/fleet/ops/earnings', { group: 'GPU I', action: 'post', ids }))
    expect(res.status).toBe(200)
    expect((await res.json()).posted).toHaveLength(2)
  })

  it('refuses an unknown action and ids that are not a list', async () => {
    expect((await earningsPost(req('/api/fleet/ops/earnings', { group: 'GPU I', action: 'delete', ids: [] }))).status).toBe(400)
    expect((await earningsPost(req('/api/fleet/ops/earnings', { group: 'GPU I', action: 'post', ids: 'x' }))).status).toBe(400)
  })
})

describe('/api/fleet/ops/payouts', () => {
  it('records with fleet write; match without accounting write → 403', async () => {
    s.accountingWrite = false
    const recorded = await payoutsPost(req('/api/fleet/ops/payouts', { group: 'GPU I', action: 'record', date: '2026-10-01', amount: 4500, reference: 'PO-1' }))
    expect(recorded.status).toBe(200)
    const { payout } = await recorded.json()
    const res = await payoutsPost(req('/api/fleet/ops/payouts', { group: 'GPU I', action: 'match', payoutId: payout.id, txnId: 't-1' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Matching a payout needs write access to Fund accounting.' })
    expect(s.m.tables.gpu_payouts[0].status).toBe('expected')
  })

  it('GET lists payouts with candidates and the receivable tie-out', async () => {
    await payoutsPost(req('/api/fleet/ops/payouts', { group: 'GPU I', action: 'record', date: '2026-10-01', amount: 4500 }))
    s.m.tables.bank_transactions.push({ id: 't-1', fund_id: 'f', vehicle_id: 'v-gpu', txn_date: '2026-10-04', amount: 4500, description: 'Payout', status: 'drafted' })
    const body = await (await payoutsGet(req('/api/fleet/ops/payouts?group=GPU%20I'))).json()
    expect(body.payouts).toEqual([expect.objectContaining({ payoutDate: '2026-10-01', amount: 4500, status: 'expected', candidates: [{ id: 't-1', txnDate: '2026-10-04', amount: 4500, description: 'Payout', status: 'drafted' }] })])
    expect(body.receivable).toMatchObject({ ledger1150: 0, postedNet: 0, matchedPayouts: 0, expected: 0, difference: 0 })
  })
})

describe('GET /api/fleet/kpis', () => {
  it('returns the month, fleet, byType, byAsset and ltm', async () => {
    await importPost(req('/api/fleet/ops/import', { group: 'GPU I', csv: CSV }))
    const res = await kpisGet(req('/api/fleet/kpis?group=GPU%20I&month=2026-09'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['byAsset', 'byType', 'fleet', 'ltm', 'month'])
    expect(body.fleet).toMatchObject({ gpuCount: 16, availableHours: 11_520, rentedHours: 7200, utilizationPct: 62.5, grossRevenue: 13_640, includesStaged: true })
    expect(body.byType.h200.gpuCount).toBe(16)
    expect(body.ltm).toMatchObject({ rentedHours: 7200, grossRevenue: 13_640 })
  })

  it('refuses a malformed month', async () => {
    expect((await kpisGet(req('/api/fleet/kpis?group=GPU%20I&month=2026-13'))).status).toBe(400)
  })
})
