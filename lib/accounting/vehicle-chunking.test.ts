import { describe, expect, it } from 'vitest'
import { memoryAdmin } from '../../tests/helpers/memory-admin'
import { IN_CHUNK, loadLedgerRowsBatch } from './load'
import { loadPositionsBatch } from './lp-positions'

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
