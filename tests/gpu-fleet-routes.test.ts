import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { GPU_SPV_CHART, DEFAULT_CHART } from '@/lib/accounting/chart'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'
import type { JournalEntry } from '@/lib/accounting/types'
import { loadCloseEntrySuggestions } from '@/lib/accounting/close-suggestions'

/**
 * ── GPU fleet (P1) ── The /api/fleet handlers. The middleware's `fleet` gate is covered in
 * gpu-fleet-gate.test.ts; here the handler's own checks: the entity resolves to a GPU SPV (a VC
 * entity is 404), anything that posts needs `accounting` write (403 otherwise, nothing booked), and
 * request payloads are validated. The entity-scope resolver is stubbed to the named group; the
 * kind check, the register and the lifecycle run for real over the memory admin.
 */

const s = vi.hoisted(() => ({ m: null as any, access: null as any, between: null as null | (() => Promise<void>), beforeWrite: null as null | (() => Promise<void>), failBeforeWrite: false }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', () => ({
  assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member', need: 'read' }),
  assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member', need: 'write' }),
}))
vi.mock('@/lib/accounting/http-vehicle', () => ({
  resolveGroupWithAccess: async (_a: any, _g: any, raw: string | null) => ({ group: raw ?? 'H200 SPV I', access: s.access }),
}))
vi.mock('@/lib/accounting/persist', () => ({
  persistEntry: vi.fn(async (_a: any, fundId: string, _g: string, _u: string, entry: JournalEntry) => {
    const t = s.m.tables
    // Before the first journal write: the window right after a purchase's claim.
    if (s.beforeWrite) { const run = s.beforeWrite; s.beforeWrite = null; await run() }
    if (s.failBeforeWrite) { s.failBeforeWrite = false; return { error: 'could not reach the database' } }
    const dup = t.journal_entries.find((e: any) => e.source_ref === entry.sourceRef && e.status !== 'void')
    if (dup) return { error: 'already in the books', duplicateOf: dup.id }
    const id = `je-${t.journal_entries.length + 1}`
    const header = { id, fund_id: fundId, vehicle_id: 'v-gpu', book: 'actual', status: 'draft', entry_date: entry.entryDate, source_type: entry.sourceType, source_ref: entry.sourceRef }
    t.journal_entries.push(header)
    for (const p of entry.postings) t.journal_postings.push({ journal_entry_id: id, fund_id: fundId, vehicle_id: 'v-gpu', book: 'actual', account_id: p.accountId, amount: p.amount })
    // The draft window persistEntry really has, for an interleaved request.
    if (s.between) { const run = s.between; s.between = null; await run() }
    header.status = 'posted'
    return { entryId: id }
  }),
}))

import * as assetTypes from '@/app/api/fleet/asset-types/route'
import * as assets from '@/app/api/fleet/assets/route'
import * as asset from '@/app/api/fleet/assets/[id]/route'
import * as purchase from '@/app/api/fleet/assets/[id]/purchase/route'
import * as capex from '@/app/api/fleet/assets/[id]/capex/route'
import * as dispose from '@/app/api/fleet/assets/[id]/dispose/route'
import * as events from '@/app/api/fleet/assets/[id]/events/route'
import * as contracts from '@/app/api/fleet/datacenter-contracts/route'
import * as contract from '@/app/api/fleet/datacenter-contracts/[id]/route'
import { purchaseAsset } from '@/lib/gpu/assets'

const access = (grants: Record<string, string>) => ({
  fundId: 'f', userId: 'u', role: 'member', vehicles: { all: true, ids: [] }, grants, defaults: {},
  features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', gpu_fleet: 'everyone' },
})
const BOOKKEEPER = access({ fleet: 'write', accounting: 'write' })
const FLEET_ONLY = access({ fleet: 'write', accounting: 'read' })
const chart = (vehicleId: string, group: string, seeds: typeof GPU_SPV_CHART) =>
  seeds.map(a => ({ id: `${vehicleId}-${a.code}`, fund_id: 'f', vehicle_id: vehicleId, portfolio_group: group, code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null }))

beforeEach(() => {
  s.access = BOOKKEEPER
  s.between = null
  s.beforeWrite = null
  s.failBeforeWrite = false
  s.m = memoryAdmin({
    fund_vehicles: [
      { id: 'v-gpu', fund_id: 'f', name: 'H200 SPV I', kind: 'gpu_spv', aliases: [] },
      { id: 'v-vc', fund_id: 'f', name: 'Fund II', kind: 'fund', aliases: [] },
    ],
    chart_of_accounts: [...chart('v-gpu', 'H200 SPV I', GPU_SPV_CHART), ...chart('v-vc', 'Fund II', DEFAULT_CHART)],
    gpu_asset_types: [], gpu_assets: [
      { id: 'vc-asset-0000-4000-8000-000000000000', fund_id: 'f', vehicle_id: 'v-vc', name: 'stray', status: 'planned', gpu_count: 8, hardware_cost: 1 },
    ],
    gpu_asset_events: [], datacenter_contracts: [], accounting_schedules: [], accounting_schedule_lines: [],
    journal_entries: [], journal_postings: [],
  }, { unique: [
    { table: 'chart_of_accounts', key: r => `${r.fund_id}|${r.portfolio_group}|${r.code}` },
    { table: 'gpu_asset_types', key: r => `${r.fund_id}|${r.code}` },
  ] })
})

const url = (path: string) => `https://x.test/api/fleet/${path}`
const get = (path: string) => new NextRequest(url(path))
const send = (path: string, method: string, body: object) => new NextRequest(url(path), { method, body: JSON.stringify(body) })
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const json = async (r: Response) => ({ status: r.status, body: await r.json() })

const createAsset = async (over: object = {}) => {
  // The column defaults the database applies (the memory admin applies none), stated.
  const defaults = { status: 'planned', useful_life_months: 60, depreciation_convention: 'full_month', tax_method: 'book', tax_bonus_pct: 0 }
  const r = await json(await assets.POST(send('assets', 'POST', { group: 'H200 SPV I', name: 'H200 #1', gpu_count: 8, hardware_cost: 335_000, in_service_date: '2027-01-15', ...defaults, ...over })))
  expect(r.status).toBe(201)
  return r.body.id as string
}

describe('entity and kind', () => {
  it('a VC entity is not found on every fleet route, by group or by row', async () => {
    expect((await assets.GET(get('assets?group=Fund II'))).status).toBe(404)
    expect((await assets.POST(send('assets', 'POST', { group: 'Fund II', name: 'x', gpu_count: 8, hardware_cost: 1 }))).status).toBe(404)
    expect((await contracts.GET(get('datacenter-contracts?group=Fund II'))).status).toBe(404)
    const stray = 'vc-asset-0000-4000-8000-000000000000'
    expect((await asset.GET(get(`assets/${stray}`), params(stray))).status).toBe(404)
    expect((await purchase.POST(send(`assets/${stray}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(stray))).status).toBe(404)
    expect((await asset.GET(get('assets/nope'), params('nope'))).status).toBe(404)
  })

  it('lists a GPU SPV\'s register with capitalized costs read from the ledger', async () => {
    const id = await createAsset()
    const r = await json(await assets.GET(get('assets?group=H200 SPV I')))
    expect(r.body.assets.map((a: any) => [a.id, a.capitalized_costs, a.salvage_value])).toEqual([[id, 0, 33_500]])
  })
})

describe('booking needs accounting write', () => {
  it('purchase, capex and disposal are 403 with fleet write but accounting read, and book nothing', async () => {
    const id = await createAsset()
    s.access = FLEET_ONLY
    expect((await purchase.POST(send(`assets/${id}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(id))).status).toBe(403)
    expect((await capex.POST(send(`assets/${id}/capex`, 'POST', { key: 'k', entryDate: '2027-01-10', amount: 100 }), params(id))).status).toBe(403)
    expect((await dispose.POST(send(`assets/${id}/dispose`, 'POST', { disposedOn: '2027-06-30', proceeds: 1 }), params(id))).status).toBe(403)
    expect((await contracts.POST(send('datacenter-contracts', 'POST', { group: 'H200 SPV I', facility: 'DC', start_date: '2027-01-01', monthly_fee: 10_280 }))).status).toBe(403)
    expect(s.m.tables.journal_entries).toEqual([])
    expect(s.m.tables.datacenter_contracts).toEqual([])
  })

  it('with accounting write: purchase once, capex idempotent by key, capex after the life refused', async () => {
    const id = await createAsset()
    expect(await json(await purchase.POST(send(`assets/${id}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(id)))).toEqual({ status: 200, body: { entryId: 'je-1' } })
    expect((await purchase.POST(send(`assets/${id}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(id))).status).toBe(400)

    const cost = { key: 'INV-4471', entryDate: '2027-01-10', amount: 2_000 }
    expect((await capex.POST(send(`assets/${id}/capex`, 'POST', { ...cost, key: '' }), params(id))).status).toBe(400)
    expect(await json(await capex.POST(send(`assets/${id}/capex`, 'POST', cost), params(id)))).toEqual({ status: 200, body: { entryId: 'je-2', capitalizedCosts: 2_000 } })
    expect(await json(await capex.POST(send(`assets/${id}/capex`, 'POST', cost), params(id)))).toEqual({ status: 200, body: { entryId: 'je-2', capitalizedCosts: 2_000 } })
    const late = await json(await capex.POST(send(`assets/${id}/capex`, 'POST', { key: 'late', entryDate: '2032-01-05', amount: 10 }), params(id)))
    expect(late).toMatchObject({ status: 400, body: { error: expect.stringContaining('life ends in 2031-12') } })
    expect((await json(await asset.GET(get(`assets/${id}?as_of=2027-12-31`), params(id)))).body.capitalized_costs).toBe(2_000)
  })
})

describe('asset payloads', () => {
  it('validates the tax class on create and on the merged row at update', async () => {
    expect((await json(await assets.POST(send('assets', 'POST', { group: 'H200 SPV I', name: 'x', gpu_count: 8, hardware_cost: 1, tax_method: 'bonus', tax_life_years: 6 })))).body.error)
      .toBe('tax_life_years must be 5 or 7 for bonus')
    const id = await createAsset({ tax_method: 'bonus', tax_bonus_pct: 0.6 })
    expect((await json(await asset.PATCH(send(`assets/${id}`, 'PATCH', { tax_life_years: 6 }), params(id)))).body.error).toBe('tax_life_years must be 5 or 7 for bonus')
    expect((await asset.PATCH(send(`assets/${id}`, 'PATCH', { tax_life_years: 7 }), params(id))).status).toBe(200)
  })

  it('fixes the hardware cost once booked, refuses unknown references, deletes only a planned asset', async () => {
    const id = await createAsset()
    expect((await asset.PATCH(send(`assets/${id}`, 'PATCH', { asset_type_id: 'nope' }), params(id))).status).toBe(400)
    await purchase.POST(send(`assets/${id}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(id))
    expect((await asset.PATCH(send(`assets/${id}`, 'PATCH', { hardware_cost: 1 }), params(id))).status).toBe(409)
    expect((await asset.DELETE(send(`assets/${id}`, 'DELETE', {}), params(id))).status).toBe(409)
    const planned = await createAsset({ name: 'spare' })
    expect((await asset.DELETE(send(`assets/${planned}`, 'DELETE', {}), params(planned))).status).toBe(200)
  })

  it('the ledger, not the register link, decides what is booked: a purchase whose link failed blocks DELETE and a cost change', async () => {
    const id = await createAsset()
    // Fail the register LINK (after the claim and the posting), not the claim.
    s.between = async () => { s.m.failNext('gpu_assets', 'update', 'canceling statement due to statement timeout') }
    await expect(purchase.POST(send(`assets/${id}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(id))).rejects.toBeTruthy()
    expect(s.m.tables.gpu_assets.find((a: any) => a.id === id).purchase_entry_id).toBeUndefined()
    expect((await asset.DELETE(send(`assets/${id}`, 'DELETE', {}), params(id))).status).toBe(409)
    expect((await asset.PATCH(send(`assets/${id}`, 'PATCH', { hardware_cost: 1 }), params(id))).status).toBe(409)
    expect(s.m.tables.gpu_assets.find((a: any) => a.id === id)).toMatchObject({ hardware_cost: 335_000 })
  })

  it('a purchase claims the row first: DELETE and a cost edit inside its booking get 409; DELETE first makes the purchase refuse', async () => {
    const id = await createAsset()
    let during: number[] = []
    s.between = async () => {
      during = [
        (await asset.DELETE(send(`assets/${id}`, 'DELETE', {}), params(id))).status,
        (await asset.PATCH(send(`assets/${id}`, 'PATCH', { hardware_cost: 1 }), params(id))).status,
      ]
    }
    expect(await json(await purchase.POST(send(`assets/${id}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(id)))).toEqual({ status: 200, body: { entryId: 'je-1' } })
    expect(during).toEqual([409, 409])
    expect(s.m.tables.gpu_assets.find((a: any) => a.id === id)).toMatchObject({ status: 'ordered', purchase_entry_id: 'je-1', hardware_cost: 335_000 })

    // The other order: a purchase holding a stale planned row, the asset deleted under it.
    const other = await createAsset({ name: 'spare' })
    const stale = s.m.tables.gpu_assets.find((a: any) => a.id === other)
    expect((await asset.DELETE(send(`assets/${other}`, 'DELETE', {}), params(other))).status).toBe(200)
    const ctx = { fundId: 'f', group: 'H200 SPV I', vehicleId: 'v-gpu', userId: 'u' }
    expect(await purchaseAsset(s.m.admin, ctx, { ...stale }, { entryDate: '2027-01-05', invoiced: false })).toMatchObject({ inProgress: true })
    expect(s.m.tables.journal_entries.filter((e: any) => e.source_ref === `gpu-asset:${other}:purchase`)).toEqual([])
  })

  it('a claim cannot be released by the register: right after it, PATCH planned and DELETE are 409, and the purchase links its row', async () => {
    const id = await createAsset()
    let during: number[] = []
    s.beforeWrite = async () => {
      expect(s.m.tables.gpu_assets.find((a: any) => a.id === id).status).toBe('ordered')
      expect(s.m.tables.journal_entries).toEqual([])
      during = [
        (await asset.PATCH(send(`assets/${id}`, 'PATCH', { status: 'planned' }), params(id))).status,
        (await asset.DELETE(send(`assets/${id}`, 'DELETE', {}), params(id))).status,
      ]
    }
    expect(await json(await purchase.POST(send(`assets/${id}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(id)))).toEqual({ status: 200, body: { entryId: 'je-1' } })
    expect(during).toEqual([409, 409])
    expect(s.m.tables.gpu_assets.filter((a: any) => a.id === id)).toEqual([expect.objectContaining({ status: 'ordered', purchase_entry_id: 'je-1' })])
  })

  it('the claim window refuses every status edit and DELETE; a pre-draft failure gives the claim back so DELETE works again', async () => {
    const id = await createAsset()
    let during: number[] = []
    s.beforeWrite = async () => {
      during = [
        (await asset.PATCH(send(`assets/${id}`, 'PATCH', { status: 'ordered' }), params(id))).status,
        (await asset.PATCH(send(`assets/${id}`, 'PATCH', { status: 'in_service' }), params(id))).status,
        (await asset.DELETE(send(`assets/${id}`, 'DELETE', {}), params(id))).status,
      ]
    }
    expect((await purchase.POST(send(`assets/${id}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(id))).status).toBe(200)
    expect(during).toEqual([409, 409, 409])
    expect(s.m.tables.gpu_assets.find((a: any) => a.id === id)).toMatchObject({ status: 'ordered', purchase_entry_id: 'je-1' })
    // Once linked, the operational move is allowed.
    expect((await asset.PATCH(send(`assets/${id}`, 'PATCH', { status: 'in_service' }), params(id))).status).toBe(200)

    const spare = await createAsset({ name: 'spare' })
    s.failBeforeWrite = true
    expect((await purchase.POST(send(`assets/${spare}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(spare))).status).toBe(400)
    expect(s.m.tables.gpu_assets.find((a: any) => a.id === spare).status).toBe('planned')
    expect((await asset.DELETE(send(`assets/${spare}`, 'DELETE', {}), params(spare))).status).toBe(200)
  })

  it('a new asset is planned, or in_service/offline for a running fleet; never created ordered or disposed', async () => {
    const make = (status: string) => assets.POST(send('assets', 'POST', { group: 'H200 SPV I', name: `x-${status}`, gpu_count: 8, hardware_cost: 1, status }))
    expect((await make('ordered')).status).toBe(400)
    expect((await make('disposed')).status).toBe(400)
    for (const status of ['planned', 'in_service', 'offline']) expect((await make(status)).status, status).toBe(201)
  })

  it('status through PATCH is operational only, and applies only from the status read', async () => {
    const id = await createAsset()
    for (const status of ['ordered', 'in_service', 'offline']) {
      expect((await asset.PATCH(send(`assets/${id}`, 'PATCH', { status }), params(id))).status, `planned → ${status}`).toBe(409)
    }
    await purchase.POST(send(`assets/${id}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(id))
    expect((await asset.PATCH(send(`assets/${id}`, 'PATCH', { status: 'planned' }), params(id))).status).toBe(409)
    expect((await asset.PATCH(send(`assets/${id}`, 'PATCH', { status: 'offline' }), params(id))).status).toBe(409)
    expect((await asset.PATCH(send(`assets/${id}`, 'PATCH', { status: 'in_service' }), params(id))).status).toBe(200)
    expect((await asset.PATCH(send(`assets/${id}`, 'PATCH', { status: 'offline' }), params(id))).status).toBe(200)
    expect((await asset.PATCH(send(`assets/${id}`, 'PATCH', { status: 'in_service' }), params(id))).status).toBe(200)
    // A stale save: the row moved after this request read it, so its status predicate matches nothing.
    const from = s.m.admin.from
    s.m.admin.from = (t: string) => {
      const q = from(t)
      if (t !== 'gpu_assets') return q
      const update = q.update.bind(q)
      q.update = (v: any) => { s.m.tables.gpu_assets.find((a: any) => a.id === id).status = 'offline'; return update(v) }
      return q
    }
    expect((await asset.PATCH(send(`assets/${id}`, 'PATCH', { status: 'offline' }), params(id))).status).toBe(409)
  })

  it('a purchase that fails before writing gives its claim back; a claim left by a crash is completed by the retry', async () => {
    const id = await createAsset()
    s.failBeforeWrite = true
    expect((await purchase.POST(send(`assets/${id}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(id))).status).toBe(400)
    const back = s.m.tables.gpu_assets.find((a: any) => a.id === id)
    expect([back.status, back.purchase_entry_id ?? null]).toEqual(['planned', null])
    expect(s.m.tables.journal_entries).toEqual([])

    // A crash after the claim: ordered, unlinked, nothing booked. The retry books once and links.
    s.m.tables.gpu_assets.find((a: any) => a.id === id).status = 'ordered'
    expect(await json(await purchase.POST(send(`assets/${id}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(id)))).toEqual({ status: 200, body: { entryId: 'je-1' } })
    expect(s.m.tables.journal_entries.filter((e: any) => e.source_ref === `gpu-asset:${id}:purchase`)).toHaveLength(1)
    expect(s.m.tables.gpu_assets.find((a: any) => a.id === id)).toMatchObject({ status: 'ordered', purchase_entry_id: 'je-1' })
  })

  it('a booked purchase whose register row vanished is a conflict naming the entry, never a success', async () => {
    const id = await createAsset()
    s.m.tables.gpu_assets.find((a: any) => a.id === id).status = 'ordered'
    s.between = async () => { s.m.tables.gpu_assets = s.m.tables.gpu_assets.filter((a: any) => a.id !== id) }
    const r = await json(await purchase.POST(send(`assets/${id}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(id)))
    expect(r).toMatchObject({ status: 409, body: { conflict: true, error: expect.stringContaining('booked as entry je-1') } })
  })

  it('an unclaimed asset may change status mid-booking without making the link miss', async () => {
    const id = await createAsset({ status: 'in_service' })
    s.between = async () => {
      expect((await asset.PATCH(send(`assets/${id}`, 'PATCH', { status: 'offline' }), params(id))).status).toBe(200)
    }
    expect(await json(await purchase.POST(send(`assets/${id}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(id)))).toEqual({ status: 200, body: { entryId: 'je-1' } })
    expect(s.m.tables.gpu_assets.find((a: any) => a.id === id)).toMatchObject({ status: 'offline', purchase_entry_id: 'je-1' })
  })

  it('locks the in-service date and convention once depreciation is booked', async () => {
    const id = await createAsset()
    s.m.tables.journal_entries.push({ id: 'je-dep', fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', status: 'posted', entry_date: '2027-01-31', source_type: 'partnership_expense', source_ref: `gpu-dep:${id}:2027-01` })
    expect((await asset.PATCH(send(`assets/${id}`, 'PATCH', { in_service_date: '2027-03-01' }), params(id))).status).toBe(409)
    expect((await asset.PATCH(send(`assets/${id}`, 'PATCH', { depreciation_convention: 'mid_month' }), params(id))).status).toBe(409)
    expect((await asset.PATCH(send(`assets/${id}`, 'PATCH', { notes: 'rack 4', in_service_date: '2027-01-15' }), params(id))).status).toBe(200)
  })

  it('asset types: created once per code', async () => {
    const body = { code: 'h200-nvl', label: 'H200 NVL', gpus_per_server: 8, anchor_rate: 4.5 }
    expect((await assetTypes.POST(send('asset-types', 'POST', body))).status).toBe(201)
    expect((await assetTypes.POST(send('asset-types', 'POST', body))).status).toBe(409)
    expect((await assetTypes.POST(send('asset-types', 'POST', { ...body, code: 'H200 NVL' }))).status).toBe(400)
    expect((await json(await assetTypes.GET())).body.assetTypes.map((t: any) => t.code)).toEqual(['h200-nvl'])
  })

  it('events: bounded by the server\'s GPU count, listed in order', async () => {
    const id = await createAsset()
    expect((await events.POST(send(`assets/${id}/events`, 'POST', { kind: 'downtime', starts_at: '2027-03-01T00:00:00Z', gpus_affected: 9 }), params(id))).status).toBe(400)
    expect((await events.POST(send(`assets/${id}/events`, 'POST', { kind: 'reboot', starts_at: '2027-03-01T00:00:00Z' }), params(id))).status).toBe(400)
    await events.POST(send(`assets/${id}/events`, 'POST', { kind: 'maintenance', starts_at: '2027-04-01T00:00:00Z' }), params(id))
    expect((await events.POST(send(`assets/${id}/events`, 'POST', { kind: 'downtime', starts_at: '2027-03-01T00:00:00Z', ends_at: '2027-03-02T00:00:00Z', gpus_affected: 2 }), params(id))).status).toBe(201)
    expect((await json(await events.GET(get(`assets/${id}/events`), params(id)))).body.events.map((e: any) => e.kind)).toEqual(['downtime', 'maintenance'])
  })
})

describe('asset valuation as of a date (#95)', () => {
  // 335,000 in service from January 2027: 5,025 a month for twelve posted months, then 4,800 of capex
  // in January 2028, depreciated prospectively over the 48 months left (+100 a month).
  const setUp = async (over: object = {}) => {
    const id = await createAsset(over)
    await purchase.POST(send(`assets/${id}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(id))
    const acc = s.m.tables.chart_of_accounts.find((a: any) => a.code === `1650-${id.slice(0, 8)}`).id
    for (let i = 1; i <= 12; i++) {
      const month = `2027-${String(i).padStart(2, '0')}`
      const eid = `dep-${month}`
      s.m.tables.journal_entries.push({ id: eid, fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', status: 'posted', entry_date: `${month}-28`, source_type: 'partnership_expense', source_ref: `gpu-dep:${id}:${month}` })
      s.m.tables.journal_postings.push({ journal_entry_id: eid, fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', account_id: acc, amount: -5_025 })
    }
    await capex.POST(send(`assets/${id}/capex`, 'POST', { key: 'INV-1', entryDate: '2028-01-10', amount: 4_800 }), params(id))
    return id
  }
  const value = async (id: string, q = '') => (await json(await asset.GET(get(`assets/${id}${q}`), params(id)))).body

  it('after a mid-life capex the NBV follows the prospective schedule, not an overstated one', async () => {
    const id = await setUp()
    expect(await value(id, '?as_of=2028-01-31')).toMatchObject({
      valuation_as_of: '2028-01-31', basis: 339_800, capitalized_costs: 4_800,
      accumulated_book: 60_300 + 5_125, nbv_book: 339_800 - 65_425,
      accumulated_tax: 65_425, nbv_tax: 274_375,
      capex_events: [{ month: '2028-01', amount: 4_800, source_ref: `gpu-asset:${id}:capex:INV-1` }],
    })
    // The list returns the same figures, batched for the vehicle.
    const listed = (await json(await assets.GET(get('assets?group=H200 SPV I&as_of=2028-01-31')))).body.assets.find((a: any) => a.id === id)
    expect(listed).toMatchObject({ nbv_book: 274_375, capitalized_costs: 4_800 })
  })

  it('as_of before the capex excludes it', async () => {
    const id = await setUp()
    expect(await value(id, '?as_of=2027-12-31')).toMatchObject({
      basis: 335_000, capitalized_costs: 0, accumulated_book: 60_300, nbv_book: 274_700, capex_events: [],
    })
  })

  it('tax depreciation follows the asset\'s own method on the same basis', async () => {
    const id = await setUp({ tax_method: 'macrs_5' })
    // 2027: 20% of 335,000 (the capex came in 2028).
    expect(await value(id, '?as_of=2027-12-31')).toMatchObject({ accumulated_tax: 67_000, nbv_tax: 268_000, nbv_book: 274_700 })
  })

  const listed = async (id: string, asOf: string) =>
    (await json(await assets.GET(get(`assets?group=H200 SPV I&as_of=${asOf}`)))).body.assets.find((a: any) => a.id === id)

  it('nothing depreciates before the purchase is recognised: an unbooked asset, and a date before a later purchase', async () => {
    const unbooked = await createAsset()
    for (const v of [await value(unbooked, '?as_of=2027-01-31'), await listed(unbooked, '2027-01-31')]) {
      expect(v).toMatchObject({ accumulated_book: 0, nbv_book: 335_000, accumulated_tax: 0, nbv_tax: 335_000 })
    }
    const later = await createAsset({ name: 'later' })
    await purchase.POST(send(`assets/${later}/purchase`, 'POST', { entryDate: '2027-03-05' }), params(later))
    for (const v of [await value(later, '?as_of=2027-01-31'), await listed(later, '2027-01-31')]) {
      expect(v).toMatchObject({ accumulated_book: 0, nbv_book: 335_000 })
    }
    expect(await value(later, '?as_of=2027-03-31')).toMatchObject({ accumulated_book: 3 * 5_025 })
  })

  it('straight-line tax runs on its own inputs, not the posted book charges', async () => {
    // 600 cost, 60 book salvage, 60 months: book posts 9 a month; tax recovers the full 600 over 5 years (10 a month).
    const id = await createAsset({ hardware_cost: 600, tax_method: 'straight_line', tax_life_years: 5 })
    await purchase.POST(send(`assets/${id}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(id))
    const acc = s.m.tables.chart_of_accounts.find((a: any) => a.code === `1650-${id.slice(0, 8)}`).id
    for (let i = 1; i <= 12; i++) {
      const month = `2027-${String(i).padStart(2, '0')}`
      s.m.tables.journal_entries.push({ id: `sl-${month}`, fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', status: 'posted', entry_date: `${month}-28`, source_type: 'partnership_expense', source_ref: `gpu-dep:${id}:${month}` })
      s.m.tables.journal_postings.push({ journal_entry_id: `sl-${month}`, fund_id: 'f', vehicle_id: 'v-gpu', book: 'actual', account_id: acc, amount: -9 })
    }
    expect(await value(id, '?as_of=2027-12-31')).toMatchObject({ accumulated_book: 108, nbv_book: 492, accumulated_tax: 120, nbv_tax: 480 })
  })

  it('a disposal-month charge counts from the disposal date, not the month end', async () => {
    const id = await createAsset()
    await purchase.POST(send(`assets/${id}/purchase`, 'POST', { entryDate: '2027-01-05' }), params(id))
    Object.assign(s.m.tables.gpu_assets.find((a: any) => a.id === id), { status: 'disposed', disposed_on: '2027-02-10' })
    const v = await value(id, '?as_of=2027-02-20')
    expect(v).toMatchObject({ accumulated_book: 2 * 5_025, nbv_book: 0 })
  })

  it('a later capex is its own tax asset from its own month, not folded into year one', async () => {
    const id = await setUp({ tax_method: 'macrs_5' })
    // 2027: 20% of 335,000; 2028: 32% of 335,000 plus 20% of the 4,800 placed in service in January 2028.
    expect(await value(id, '?as_of=2028-01-31')).toMatchObject({ accumulated_tax: 67_000 + 107_200 + 960, nbv_tax: 339_800 - 175_160 })
  })

  it('defaults to today and refuses an invalid date', async () => {
    const id = await createAsset()
    expect((await value(id)).valuation_as_of).toBe(new Date().toISOString().slice(0, 10))
    for (const bad of ['2027-13-01', '2027-02-30', 'tomorrow']) {
      expect((await asset.GET(get(`assets/${id}?as_of=${bad}`), params(id))).status, bad).toBe(400)
      expect((await assets.GET(get(`assets?group=H200 SPV I&as_of=${bad}`))).status, bad).toBe(400)
    }
  })
})

describe('datacenter contracts', () => {
  const create = (over: object = {}) => contracts.POST(send('datacenter-contracts', 'POST', {
    group: 'H200 SPV I', facility: 'Austin DC', start_date: '2027-01-01', monthly_fee: 10_280, escalator_pct: 0.05, ...over,
  }))

  it('creates the contract and its accrual schedule; fee terms are fixed once accruing', async () => {
    const r = await json(await create())
    expect(r.status).toBe(201)
    expect(r.body.schedule.created).toBeGreaterThan(0)
    const id = r.body.contract.id
    expect((await contract.PATCH(send(`datacenter-contracts/${id}`, 'PATCH', { monthly_fee: 11_000 }), params(id))).status).toBe(409)
    expect((await contract.PATCH(send(`datacenter-contracts/${id}`, 'PATCH', { power_kw: 40, status: 'ended', end_date: '2030-12-31' }), params(id))).status).toBe(200)
    expect(await json(await contract.POST(send(`datacenter-contracts/${id}`, 'POST', { action: 'roll', asOf: '2026-01-01' }), params(id)))).toMatchObject({ status: 200, body: { created: 0 } })
  })

  it('ending a contract ends its accruals at the contract end; a later roll recreates nothing', async () => {
    const id = (await json(await create({ escalator_pct: 0 }))).body.contract.id
    const proposals = (start: string, end: string) => loadCloseEntrySuggestions(s.m.admin, 'f', 'H200 SPV I', start, end)
    expect((await proposals('2027-07-01', '2027-07-31')).map(x => x.postings[0].amount)).toEqual([10_280])

    s.access = FLEET_ONLY
    expect((await contract.PATCH(send(`datacenter-contracts/${id}`, 'PATCH', { end_date: '2027-06-30' }), params(id))).status).toBe(403)
    s.access = BOOKKEEPER
    expect((await contract.PATCH(send(`datacenter-contracts/${id}`, 'PATCH', { status: 'ended' }), params(id))).status).toBe(400)
    expect(await json(await contract.PATCH(send(`datacenter-contracts/${id}`, 'PATCH', { status: 'ended', end_date: '2027-06-30' }), params(id))))
      .toMatchObject({ status: 200, body: { schedulesEnded: 1 } })
    expect((await proposals('2027-06-01', '2027-06-30')).map(x => x.postings[0].amount)).toEqual([10_280])
    expect(await proposals('2027-07-01', '2027-07-31')).toEqual([])
    await contract.POST(send(`datacenter-contracts/${id}`, 'POST', { action: 'roll', asOf: '2028-06-30' }), params(id))
    expect(await proposals('2027-07-01', '2027-07-31')).toEqual([])
    expect(s.m.tables.accounting_schedules).toHaveLength(1)
  })

  it('the first escalation date must follow the start; one after the end simply never applies', async () => {
    expect((await create({ first_escalation_date: '2027-01-01' })).status).toBe(400)
    expect((await create({ schedule: false, first_escalation_date: '2029-01-01', end_date: '2028-12-31' })).status).toBe(201)
  })

  it('an accruing contract can end early, before an explicit future escalation', async () => {
    const id = (await json(await create({ first_escalation_date: '2027-07-01' }))).body.contract.id
    expect(await json(await contract.PATCH(send(`datacenter-contracts/${id}`, 'PATCH', { end_date: '2027-06-30', status: 'ended' }), params(id))))
      .toMatchObject({ status: 200, body: { schedulesEnded: 1 } })
    expect(await loadCloseEntrySuggestions(s.m.admin, 'f', 'H200 SPV I', '2027-07-01', '2027-07-31')).toEqual([])
  })

  it('a termination whose schedule write failed is repaired by the identical retry', async () => {
    const id = (await json(await create({ escalator_pct: 0 }))).body.contract.id
    s.m.failNext('accounting_schedules', 'update', 'canceling statement due to statement timeout')
    await expect(contract.PATCH(send(`datacenter-contracts/${id}`, 'PATCH', { status: 'ended', end_date: '2027-06-30' }), params(id))).rejects.toBeTruthy()
    expect(s.m.tables.datacenter_contracts[0]).toMatchObject({ status: 'ended', end_date: '2027-06-30' })
    expect(s.m.tables.accounting_schedules[0].end_date).toBeNull()
    expect(await json(await contract.PATCH(send(`datacenter-contracts/${id}`, 'PATCH', { status: 'ended', end_date: '2027-06-30' }), params(id))))
      .toMatchObject({ status: 200, body: { schedulesEnded: 1 } })
    expect(await loadCloseEntrySuggestions(s.m.admin, 'f', 'H200 SPV I', '2027-07-01', '2027-07-31')).toEqual([])
    // Already aligned: a further save changes nothing and needs no accounting write.
    s.access = FLEET_ONLY
    expect(await json(await contract.PATCH(send(`datacenter-contracts/${id}`, 'PATCH', { power_kw: 40 }), params(id)))).toMatchObject({ status: 200, body: { schedulesEnded: 0 } })
  })

  it('ending a contract ends every materialised period: the current one shortened, later ones deactivated', async () => {
    const id = (await json(await create())).body.contract.id
    await contract.POST(send(`datacenter-contracts/${id}`, 'POST', { action: 'roll', asOf: '2029-06-01' }), params(id))
    const rows = () => s.m.tables.accounting_schedules.map((r: any) => [r.start_date, r.end_date, r.active])
    expect(rows()).toEqual([['2027-01-01', '2027-12-31', true], ['2028-01-01', '2028-12-31', true], ['2029-01-01', null, true]])
    expect(await json(await contract.PATCH(send(`datacenter-contracts/${id}`, 'PATCH', { status: 'ended', end_date: '2027-09-30' }), params(id))))
      .toMatchObject({ status: 200, body: { schedulesEnded: 3 } })
    expect(rows()).toEqual([['2027-01-01', '2027-09-30', true], ['2028-01-01', '2028-12-31', false], ['2029-01-01', null, false]])
    for (const [start, end] of [['2027-10-01', '2027-10-31'], ['2028-06-01', '2028-06-30'], ['2029-06-01', '2029-06-30']]) {
      expect(await loadCloseEntrySuggestions(s.m.admin, 'f', 'H200 SPV I', start, end), start).toEqual([])
    }
  })

  it('an ended contract is not reopened or extended', async () => {
    const id = (await json(await create({ escalator_pct: 0 }))).body.contract.id
    await contract.PATCH(send(`datacenter-contracts/${id}`, 'PATCH', { status: 'ended', end_date: '2027-06-30' }), params(id))
    for (const body of [{ status: 'active' }, { end_date: '2027-12-31' }, { end_date: null }]) {
      expect((await contract.PATCH(send(`datacenter-contracts/${id}`, 'PATCH', body), params(id))).status, JSON.stringify(body)).toBe(409)
    }
    expect(s.m.tables.datacenter_contracts[0]).toMatchObject({ status: 'ended', end_date: '2027-06-30' })
  })

  it('validates the payload; schedule: false needs only fleet write; roll needs accounting write', async () => {
    expect((await create({ monthly_fee: -1 })).status).toBe(400)
    expect((await create({ start_date: '2027-06-01', end_date: '2027-01-01' })).status).toBe(400)
    s.access = FLEET_ONLY
    const r = await json(await create({ schedule: false }))
    expect(r.status).toBe(201)
    expect(s.m.tables.accounting_schedules).toEqual([])
    expect((await contract.POST(send(`datacenter-contracts/${r.body.contract.id}`, 'POST', { action: 'roll' }), params(r.body.contract.id))).status).toBe(403)
  })
})
