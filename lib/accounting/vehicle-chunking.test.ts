import { describe, expect, it } from 'vitest'
import { memoryAdmin } from '../../tests/helpers/memory-admin'
import { fetchAllRowsIn, IN_CHUNK, loadEntityClasses, loadEntityNames, loadLedgerRowsBatch } from './load'
import { loadPositionsBatch } from './lp-positions'
import { loadOpeningLinks, loadOpeningLinksBatch } from './capital-source'
import { loadFundPreload } from './fund-preload'

/**
 * The batch loaders filter by `vehicle_id IN (...)`, and that list rides in the GET URL: past ~400
 * uuids one request overruns Supabase's 16 KB URL limit (#26). They chunk the ids, so no request
 * carries more than IN_CHUNK of them and every vehicle's rows still land in its own slice.
 */
const FUND = 'f'
const N = 450
const vid = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`
const ids = Array.from({ length: N }, (_, i) => vid(i))

function seed() {
  return {
    chart_of_accounts: ids.map((v, i) => ({ id: `a${i}`, fund_id: FUND, vehicle_id: v, code: '1000', name: 'Cash', type: 'asset' })),
    journal_entries: ids.map((v, i) => ({ id: `e${i}`, fund_id: FUND, vehicle_id: v, book: 'actual', status: 'posted', entry_date: '2025-01-01' })),
    journal_postings: ids.flatMap((v, i) => [
      { id: `p${i}d`, journal_entry_id: `e${i}`, fund_id: FUND, vehicle_id: v, book: 'actual', account_id: `a${i}`, amount: 1 },
      { id: `p${i}c`, journal_entry_id: `e${i}`, fund_id: FUND, vehicle_id: v, book: 'actual', account_id: `a${i}`, amount: -1 },
    ]),
    lp_positions: ids.map((v, i) => ({ id: `lp${i}`, fund_id: FUND, vehicle_id: v, lp_entity_id: `ent${i}`, as_of_date: '2025-03-31' })),
  }
}

/** Records the size of every `.in()` list sent, per table. */
function recordIn(admin: any) {
  const sent: { table: string; n: number }[] = []
  const from = admin.from.bind(admin)
  admin.from = (table: string) => {
    const q = from(table)
    const inner = q.in
    q.in = (col: string, vs: unknown[]) => { sent.push({ table, n: vs.length }); return inner(col, vs) }
    return q
  }
  return sent
}

describe('batch loaders chunk the vehicle id list (#26)', () => {
  it('loadLedgerRowsBatch: every vehicle gets its rows, no request over the chunk size', async () => {
    const { admin } = memoryAdmin(seed(), { maxRows: 1000 })
    const sent = recordIn(admin)
    const rows = await loadLedgerRowsBatch(admin as any, FUND, ids)
    expect(rows.size).toBe(N)
    for (const [i, v] of ids.entries()) {
      const r = rows.get(v)!
      expect(r.acctRows.map(a => a.id)).toEqual([`a${i}`])
      expect(r.entryRows.map(e => e.id)).toEqual([`e${i}`])
      expect(r.postingRows).toHaveLength(2)
    }
    expect(Math.max(...sent.map(s => s.n))).toBe(IN_CHUNK)
    for (const table of ['chart_of_accounts', 'journal_entries', 'journal_postings']) {
      // 450 ids → 200 + 200 + 50, one paged read per chunk.
      expect(sent.filter(s => s.table === table).map(s => s.n)).toEqual([200, 200, 50])
    }
  })

  it('loadPositionsBatch: every vehicle gets its positions, no request over the chunk size', async () => {
    const { admin } = memoryAdmin(seed(), { maxRows: 1000 })
    const sent = recordIn(admin)
    const positions = await loadPositionsBatch(admin as any, FUND, ids)
    expect(positions.size).toBe(N)
    for (const [i, v] of ids.entries()) expect(positions.get(v)!.map(p => p.lpEntityId)).toEqual([`ent${i}`])
    expect(sent.map(s => s.n)).toEqual([200, 200, 50])
  })
})

describe('fetchAllRowsIn appends a chunk of any size', () => {
  it('returns a chunk whose rows far exceed the argument limit of one push(...spread)', async () => {
    // IN_CHUNK bounds the ids, not the rows: one chunk of vehicles with long histories returns
    // hundreds of pages. A synthetic 300,000-row table, served 1000 rows a page.
    const TOTAL = 300_000
    const row = { vehicle_id: vid(0) }
    let reads = 0
    const make = (_ids: string[], from: number, to: number) => {
      reads++
      const q: any = {
        order: () => q,
        then: (resolve: any) => resolve({ data: Array.from({ length: Math.max(0, Math.min(to, TOTAL - 1) - from + 1) }, () => row), error: null }),
      }
      return q
    }
    const rows = await fetchAllRowsIn([vid(0)], make)
    expect(rows).toHaveLength(TOTAL)
    expect(reads).toBe(TOTAL / 1000 + 1)
  })
})

describe('opening links read past the row cap', () => {
  it('loadOpeningLinksBatch returns every link across vehicles, matching the single-vehicle loader', async () => {
    // 3 vehicles × 400 partners = 1200 links; the table has no id, so the order is position_id.
    const capital_opening_links = ids.slice(0, 3).flatMap((v, vi) => Array.from({ length: 400 }, (_, i) => ({
      fund_id: FUND, vehicle_id: v, lp_entity_id: `ent${vi}-${i}`, position_id: `pos${vi}-${String(i).padStart(3, '0')}`,
      journal_entry_id: `je${vi}-${i}`, observed_on: '2025-03-31', observed_nav: 100, booked_amount: 100,
    })))
    const { admin } = memoryAdmin({ capital_opening_links }, { maxRows: 1000 })
    const batch = await loadOpeningLinksBatch(admin as any, FUND, ids.slice(0, 3))
    for (const v of ids.slice(0, 3)) {
      expect(batch.get(v)).toHaveLength(400)
      expect(batch.get(v)).toEqual(await loadOpeningLinks(admin as any, FUND, v))
    }
  })

  it('throws on a failed read', async () => {
    const m = memoryAdmin({ capital_opening_links: [] }, { maxRows: 1000 })
    m.failNext('capital_opening_links', 'select', 'timeout')
    await expect(loadOpeningLinksBatch(m.admin as any, FUND, ids.slice(0, 1))).rejects.toMatchObject({ message: 'timeout' })
  })
})

describe('loadFundPreload with more vehicles than one request can name', () => {
  it('chunks every batch read at IN_CHUNK ids, and every vehicle gets its rows', async () => {
    const base = seed()
    const { admin } = memoryAdmin({
      ...base,
      fund_vehicles: ids.map((v, i) => ({ id: v, fund_id: FUND, name: `Fund ${i}`, aliases: [] })),
      capital_opening_links: ids.map((v, i) => ({ fund_id: FUND, vehicle_id: v, lp_entity_id: `ent${i}`, position_id: `lp${i}`, journal_entry_id: `e${i}`, observed_on: '2025-03-31', booked_amount: 1 })),
    }, { maxRows: 1000 })
    const sent = recordIn(admin)
    const p = await loadFundPreload(admin as any, FUND)

    for (const [i, v] of ids.entries()) {
      expect(p.ledgerByVehicleId.get(v)!.postingRows).toHaveLength(2)
      expect(p.positionsByVehicleId.get(v)!.map(x => x.lpEntityId)).toEqual([`ent${i}`])
      expect(p.openingLinksByVehicleId.get(v)!.map(x => x.positionId)).toEqual([`lp${i}`])
    }
    // commitment_events (terms.ts loadCommitmentEventsBatch) is chunked in #24, not here.
    for (const table of ['chart_of_accounts', 'journal_entries', 'journal_postings', 'lp_positions', 'capital_opening_links']) {
      expect(sent.filter(s => s.table === table).map(s => s.n), table).toEqual([200, 200, 50])
    }
  })
})

describe('entity names and classes for more entities than one request can name', () => {
  it('loadEntityNames and loadEntityClasses chunk the entity ids and name every partner', async () => {
    const entities = Array.from({ length: N }, (_, i) => ({ id: `ent${String(i).padStart(4, '0')}`, fund_id: FUND, entity_name: `Partner ${i}`, partner_class: 'lp' }))
    const { admin } = memoryAdmin({
      lp_entities: entities,
      lp_investments: entities.map(e => ({ id: `inv-${e.id}`, fund_id: FUND, portfolio_group: 'Fund I', entity_id: e.id })),
    }, { maxRows: 1000 })
    const sent = recordIn(admin)
    const names = await loadEntityNames(admin as any, FUND, 'Fund I')
    const classes = await loadEntityClasses(admin as any, FUND, 'Fund I')
    expect(names.size).toBe(N)
    expect(names.get('ent0449')).toBe('Partner 449')
    expect(classes.size).toBe(N)
    expect(sent.filter(s => s.table === 'lp_entities').map(s => s.n)).toEqual([200, 200, 50, 200, 200, 50])
  })

  it('fetchAllRowsIn dedupes its ids', async () => {
    const asked: string[][] = []
    const make = (chunk: string[]) => { asked.push(chunk); const q: any = { order: () => q, then: (r: any) => r({ data: [], error: null }) }; return q }
    await fetchAllRowsIn(['a', 'b', 'a', 'b', 'c'], make)
    expect(asked).toEqual([['a', 'b', 'c']])
  })
})
