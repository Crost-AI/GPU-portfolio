import { describe, expect, it } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { latestPositionIrrFrom, loadPositions, loadPositionsBatch } from './lp-positions'

/**
 * lp_positions holds one row per LP per as-of date, written oldest first, so a read truncated at
 * PostgREST's max_rows (1000, supabase/config.toml) loses every LP's LATEST position. Both loaders
 * page; the client here enforces the cap.
 */
const quarters = ['2023-03-31', '2023-06-30', '2023-09-30', '2023-12-31']
const seed = () => ({
  fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I' }, { id: 'v2', fund_id: 'f', name: 'Fund II' }],
  // 2 vehicles × 150 LPs × 4 dates = 1200 rows, oldest date first; the latest carries irr = 0.2.
  lp_positions: quarters.flatMap((d, qi) => ['v1', 'v2'].flatMap(v => Array.from({ length: 150 }, (_, i) => ({
    id: `${v}-${String(i).padStart(3, '0')}-${qi}`, fund_id: 'f', vehicle_id: v, lp_entity_id: `${v}-e${i}`, as_of_date: d,
    commitment: 1000, called_capital: 100 * (qi + 1), distributions: 0, nav: 100 * (qi + 1), irr: qi === 3 ? 0.2 : 0.1,
  })))),
})

describe('lp positions read past the 1000-row cap', () => {
  it('loadPositionsBatch returns every position, every LP on its latest date', async () => {
    const { admin } = memoryAdmin(seed(), { maxRows: 1000 })
    const batch = await loadPositionsBatch(admin as any, 'f', ['v1', 'v2'])
    for (const v of ['v1', 'v2']) {
      const positions = batch.get(v)!
      expect(positions).toHaveLength(600)
      const latest = latestPositionIrrFrom(positions)
      expect(latest.size).toBe(150)
      expect([...latest.values()].every(irr => irr === 0.2)).toBe(true)
    }
  })

  it('the single-vehicle loader returns the same set as its batch slice', async () => {
    const { admin } = memoryAdmin(seed(), { maxRows: 1000 })
    const one = await loadPositions(admin as any, 'f', 'Fund I')
    const batch = (await loadPositionsBatch(admin as any, 'f', ['v1', 'v2'])).get('v1')!
    const ids = (ps: { id?: string }[]) => ps.map(p => p.id).sort()
    expect(one).toHaveLength(600)
    expect(ids(one)).toEqual(ids(batch))
  })

  it('throws on a failed read rather than returning no positions', async () => {
    const m = memoryAdmin(seed(), { maxRows: 1000 })
    m.failNext('lp_positions', 'select', 'timeout')
    await expect(loadPositionsBatch(m.admin as any, 'f', ['v1'])).rejects.toMatchObject({ message: 'timeout' })
  })
})
