import { describe, expect, it } from 'vitest'
import { capacityHours, dedupHash, findAsset, matchAssets } from './match'
import { parseEarningsCsv } from './parse'

const assets = [
  { id: 'a-1', name: 'H200 #1', serials: ['SN-001'], gpu_count: 8 },
  { id: 'a-2', name: 'H200 #2', serials: [], gpu_count: 8 },
]
const parse = (csv: string) => parseEarningsCsv(csv).rows

describe('findAsset', () => {
  it('matches the name (case and spaces aside), then a serial, then the id', () => {
    expect(findAsset('  h200 #1 ', assets)?.id).toBe('a-1')
    expect(findAsset('sn-001', assets)?.id).toBe('a-1')
    expect(findAsset('a-2', assets)?.id).toBe('a-2')
    expect(findAsset('H100 #9', assets)).toBeNull()
  })
})

describe('matchAssets', () => {
  it('derives utilization from rented hours, and rented hours from utilization', () => {
    expect(capacityHours(8, '2026-09-01', '2026-09-30')).toBe(5760)
    const { rows, errors } = matchAssets(parse('H200 #1,2026-09-01,2026-09-30,4320,,8640\nH200 #2,2026-09-01,2026-09-30,,62.5,7200'), assets)
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ assetId: 'a-1', assetName: 'H200 #1', gpuHoursRented: 4320, utilizationPct: 75, status: 'staged' })
    expect(rows[1]).toMatchObject({ assetId: 'a-2', gpuHoursRented: 3600, utilizationPct: 62.5, status: 'staged' })
  })

  it('keeps an unknown asset as unmatched, with only the figure that was typed', () => {
    const { rows, unmatched } = matchAssets(parse('Ghost,2026-09-01,2026-09-30,100,,10'), assets)
    expect(unmatched).toBe(1)
    expect(rows[0]).toMatchObject({ assetId: null, status: 'unmatched', gpuHoursRented: 100, utilizationPct: null })
  })

  it('refuses rented or downtime hours above what the server has in the period', () => {
    const { rows, errors } = matchAssets(parse('H200 #1,2026-09-01,2026-09-30,5761,,1\nH200 #2,2026-09-01,2026-09-30,1,,1,0,1,5761'), assets)
    expect(rows).toEqual([])
    expect(errors[0]).toMatch(/^Row 1: 5761 rented GPU-hours is more than H200 #1 can sell/)
    expect(errors[1]).toMatch(/^Row 2: 5761 downtime GPU-hours/)
  })

  it('refuses a second row for the same server and period in one paste', () => {
    const { rows, errors } = matchAssets(parse('H200 #1,2026-09-01,2026-09-30,1,,1\nsn-001,2026-09-01,2026-09-30,2,,2'), assets)
    expect(rows).toHaveLength(1)
    expect(errors).toEqual(['Row 2: H200 #1 2026-09-01..2026-09-30 appears twice in this paste'])
  })
})

describe('dedupHash', () => {
  const [row] = parse('H200 #1,2026-09-01,2026-09-30,4320,,8640,864,7776')
  it('is stable, per vehicle, per occurrence, and sees every figure', () => {
    expect(dedupHash('v', row)).toBe(dedupHash('v', { ...row, assetRef: ' h200 #1' }))
    expect(dedupHash('v', row)).toMatch(/^[0-9a-f]{64}$/)
    expect(dedupHash('v', row)).not.toBe(dedupHash('w', row))
    expect(dedupHash('v', row, 1)).not.toBe(dedupHash('v', row))
    expect(dedupHash('v', { ...row, downtimeHours: 1 })).not.toBe(dedupHash('v', row))
    expect(dedupHash('v', { ...row, gross: 8641, net: 7777 })).not.toBe(dedupHash('v', row))
  })
})
