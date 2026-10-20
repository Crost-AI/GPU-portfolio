import { describe, expect, it } from 'vitest'
import { computeKpis, daysInService, ltm, monthBounds, trailingMonths, type KpiAsset, type KpiEarning } from './kpis'

const asset = (id: string, over: Partial<KpiAsset> = {}): KpiAsset => ({ id, name: `H200 #${id}`, gpu_count: 8, in_service_date: '2026-01-01', disposed_on: null, type_code: 'h200', ...over })
const earning = (asset_id: string, over: Partial<KpiEarning> = {}): KpiEarning => ({
  asset_id, period_end: '2026-09-30', status: 'posted', gpu_hours_rented: 4320, gross: 8640, marketplace_fee: 864, net: 7776, downtime_hours: 0, ...over,
})

describe('computeKpis', () => {
  // The plan's fixture: 3 servers × 8 GPUs, September 2026 (720 h).
  const assets = [asset('1'), asset('2'), asset('3')]
  const earnings = [earning('1'), earning('2'), earning('3', { downtime_hours: 172.8 })]

  it('24 GPUs × 720 h, 12,960 rented → 75.0 %, $25,920 gross → 2.00 $/GPU-hr', () => {
    const k = computeKpis({ assets, earnings, month: '2026-09' })
    expect(k.fleet).toEqual({
      gpuCount: 24, availableHours: 17_280, rentedHours: 12_960, utilizationPct: 75, grossRevenue: 25_920, fee: 2_592, net: 23_328,
      realizedRate: 2, downtimeHours: 172.8, uptimePct: 99, revenuePerGpuMonth: 1_080, includesStaged: false,
    })
    expect(k.byType.h200.utilizationPct).toBe(75)
    expect(k.byAsset['3']).toMatchObject({ name: 'H200 #3', uptimePct: 97, realizedRate: 2 })
  })

  it('counts staged rows and says so; leaves out unmatched, ignored, reversed and other months', () => {
    const k = computeKpis({
      assets,
      earnings: [
        earning('1', { status: 'staged' }), earning('2', { status: 'ignored' }), earning('3', { status: 'reversed' }),
        earning(null as any, { status: 'unmatched' }), earning('2', { period_end: '2026-10-31' }),
      ],
      month: '2026-09',
    })
    expect(k.fleet).toMatchObject({ rentedHours: 4320, grossRevenue: 8640, includesStaged: true })
    expect(k.byAsset['2']).toMatchObject({ rentedHours: 0, realizedRate: null, includesStaged: false })
  })

  it('pro-rates capacity by the in-service and disposal dates', () => {
    expect(daysInService({ in_service_date: '2026-09-16', disposed_on: null }, '2026-09-01', '2026-09-30')).toBe(15)
    expect(daysInService({ in_service_date: '2026-01-01', disposed_on: '2026-09-11' }, '2026-09-01', '2026-09-30')).toBe(10)
    expect(daysInService({ in_service_date: null, disposed_on: null }, '2026-09-01', '2026-09-30')).toBe(0)
    expect(daysInService({ in_service_date: '2026-10-01', disposed_on: null }, '2026-09-01', '2026-09-30')).toBe(0)
    const k = computeKpis({ assets: [asset('1', { in_service_date: '2026-09-16' }), asset('2', { in_service_date: null, type_code: null })], earnings: [], month: '2026-09' })
    expect(k.fleet).toMatchObject({ gpuCount: 8, availableHours: 8 * 24 * 15, utilizationPct: 0, realizedRate: null })
    expect(k.byType.untyped).toMatchObject({ gpuCount: 0, availableHours: 0, utilizationPct: null, uptimePct: null })
  })
})

describe('months', () => {
  it('bounds a month and lists the trailing twelve across a year end', () => {
    expect(monthBounds('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' })
    expect(trailingMonths('2027-03')).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'])
  })
})

describe('ltm', () => {
  it('sums twelve months and recomputes the ratios over the sums', () => {
    const month = computeKpis({ assets: [asset('1')], earnings: [earning('1')], month: '2026-09' }).fleet
    const empty = computeKpis({ assets: [asset('1')], earnings: [], month: '2026-09' }).fleet
    const year = ltm([...Array(11).fill(empty), month])
    expect(year).toMatchObject({
      gpuCount: 8, availableHours: 12 * 5760, rentedHours: 4320, grossRevenue: 8640, net: 7776,
      utilizationPct: 6.25, realizedRate: 2, revenuePerGpuMonth: 90,
    })
    expect(ltm(Array(12).fill(month))).toMatchObject({ grossRevenue: 12 * 8640, utilizationPct: 75 })
  })
})

// ── Review fixes (#90) ──
describe('a staged correction replaces the posted row it supersedes', () => {
  it('posted 75% + its staged 75% correction reads 75%, not 150%; posted-only keeps the original', () => {
    const assets = [asset('1')]
    const original = earning('1', { id: 'e-1' })
    const fix = earning('1', { id: 'e-2', status: 'staged', supersedes_id: 'e-1', gross: 9000, net: 8136 })
    const preview = computeKpis({ assets, earnings: [original, fix], month: '2026-09' })
    expect(preview.fleet).toMatchObject({ utilizationPct: 75, rentedHours: 4320, grossRevenue: 9000, includesStaged: true })
    expect(preview.byAsset['1']).toMatchObject({ utilizationPct: 75, grossRevenue: 9000 })
    const posted = computeKpis({ assets, earnings: [original], month: '2026-09' })
    expect(posted.fleet).toMatchObject({ utilizationPct: 75, grossRevenue: 8640, includesStaged: false })
  })
})
