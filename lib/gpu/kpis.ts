// Fleet KPIs for one calendar month, from the register and the operations entries. Pure.
//
// Capacity is the register's: every GPU of every server in service, every hour of the days it was
// in service that month. Rented hours, revenue and downtime are what the operator entered for
// periods ending in the month (decision Q9: downtime is the per-period figure, not the event log).

export interface KpiAsset {
  id: string
  name: string
  gpu_count: number
  in_service_date: string | null
  disposed_on: string | null
  /** The server type's code; null groups under "untyped". */
  type_code?: string | null
}

export interface KpiEarning {
  id?: string
  /** A staged correction names the posted row it replaces. */
  supersedes_id?: string | null
  asset_id: string | null
  period_end: string
  status: string
  gpu_hours_rented: number | null
  gross: number
  marketplace_fee: number
  net: number
  downtime_hours: number
}

export interface Kpi {
  gpuCount: number
  availableHours: number
  rentedHours: number
  /** rented / available, as a percentage; null with no capacity. */
  utilizationPct: number | null
  grossRevenue: number
  fee: number
  net: number
  /** gross / rented hours ($ per GPU-hour); null when nothing was rented. */
  realizedRate: number | null
  downtimeHours: number
  /** (available − downtime) / available, as a percentage; null with no capacity. */
  uptimePct: number | null
  /** gross / GPUs in service; null with none. Over several months, gross / Σ monthly GPUs. */
  revenuePerGpuMonth: number | null
  /** Staged (entered, not yet posted) rows count toward these figures. */
  includesStaged: boolean
}

export interface MonthKpis {
  month: string
  fleet: Kpi
  byType: Record<string, Kpi>
  byAsset: Record<string, Kpi & { name: string }>
}

/** Rows that count: entered and not set aside. Posting does not change the figures. */
export const KPI_STATUSES = ['staged', 'posted']
export const UNTYPED = 'untyped'

/** Calendar days in [start, end], both ends included. */
export function daysInclusive(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
}

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp

interface Sums { gpuCount: number; gpuMonths: number; availableHours: number; rentedHours: number; gross: number; fee: number; net: number; downtimeHours: number; staged: number }
const zero = (): Sums => ({ gpuCount: 0, gpuMonths: 0, availableHours: 0, rentedHours: 0, gross: 0, fee: 0, net: 0, downtimeHours: 0, staged: 0 })

function finish(s: Sums): Kpi {
  return {
    gpuCount: s.gpuCount,
    availableHours: round(s.availableHours, 4),
    rentedHours: round(s.rentedHours, 4),
    utilizationPct: s.availableHours > 0 ? round((s.rentedHours / s.availableHours) * 100, 4) : null,
    grossRevenue: round(s.gross, 2),
    fee: round(s.fee, 2),
    net: round(s.net, 2),
    realizedRate: s.rentedHours > 0 ? round(s.gross / s.rentedHours, 4) : null,
    downtimeHours: round(s.downtimeHours, 4),
    uptimePct: s.availableHours > 0 ? round(((s.availableHours - s.downtimeHours) / s.availableHours) * 100, 4) : null,
    revenuePerGpuMonth: s.gpuMonths > 0 ? round(s.gross / s.gpuMonths, 2) : null,
    includesStaged: s.staged > 0,
  }
}

/** First and last day of a YYYY-MM month. */
export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` }
}

/** The 12 months ending with `month`, oldest first. */
export function trailingMonths(month: string, n = 12): string[] {
  const [y, m] = month.split('-').map(Number)
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1))
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  })
}

/**
 * Days a server was in service in [start, end]: from its in-service date, up to the day before it
 * was disposed of (it is not available on the day it leaves). Zero before it entered service.
 */
export function daysInService(a: Pick<KpiAsset, 'in_service_date' | 'disposed_on'>, start: string, end: string): number {
  if (!a.in_service_date) return 0
  const from = a.in_service_date > start ? a.in_service_date : start
  let to = end
  if (a.disposed_on) {
    const lastDay = new Date(Date.parse(`${a.disposed_on}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    if (lastDay < to) to = lastDay
  }
  return to < from ? 0 : daysInclusive(from, to)
}

export function computeKpis(input: { assets: KpiAsset[]; earnings: KpiEarning[]; month: string }): MonthKpis {
  const { start, end } = monthBounds(input.month)
  const fleet = zero()
  const byType = new Map<string, Sums>()
  const byAsset = new Map<string, Sums>()
  const typeOf = new Map<string, string>()

  const add = (target: Sums, delta: Partial<Sums>) => { for (const [k, v] of Object.entries(delta)) (target as any)[k] += v }
  const bucket = (map: Map<string, Sums>, key: string) => { if (!map.has(key)) map.set(key, zero()); return map.get(key)! }

  for (const a of input.assets) {
    const type = a.type_code || UNTYPED
    typeOf.set(a.id, type)
    const days = daysInService(a, start, end)
    const delta = days > 0 ? { gpuCount: a.gpu_count, gpuMonths: a.gpu_count, availableHours: a.gpu_count * 24 * days } : {}
    add(fleet, delta); add(bucket(byType, type), delta); add(bucket(byAsset, a.id), delta)
  }

  // A staged correction REPLACES the posted row it supersedes: count one of them, not both. With
  // posted rows only (publication) there is no staged row, and the original counts.
  const replaced = new Set(input.earnings.filter(e => e.status === 'staged' && e.supersedes_id).map(e => e.supersedes_id!))
  for (const e of input.earnings) {
    if (!e.asset_id || !KPI_STATUSES.includes(e.status) || e.period_end < start || e.period_end > end) continue
    if (e.id && replaced.has(e.id)) continue
    if (!typeOf.has(e.asset_id)) continue
    const delta = {
      staged: e.status === 'staged' ? 1 : 0,
      rentedHours: Number(e.gpu_hours_rented ?? 0), gross: Number(e.gross), fee: Number(e.marketplace_fee),
      net: Number(e.net), downtimeHours: Number(e.downtime_hours ?? 0),
    }
    add(fleet, delta); add(bucket(byType, typeOf.get(e.asset_id)!), delta); add(bucket(byAsset, e.asset_id), delta)
  }

  const names = new Map(input.assets.map(a => [a.id, a.name]))
  return {
    month: input.month,
    fleet: finish(fleet),
    byType: Object.fromEntries(Array.from(byType, ([k, s]) => [k, finish(s)])),
    byAsset: Object.fromEntries(Array.from(byAsset, ([k, s]) => [k, { name: names.get(k) ?? k, ...finish(s) }])),
  }
}

/**
 * The trailing twelve months from monthly fleet figures: hours, revenue and downtime summed, the
 * ratios recomputed over the sums (not averaged), GPUs as of the last month, and revenue per GPU
 * over the GPU-months.
 */
export function ltm(monthly: Kpi[]): Kpi {
  const s = zero()
  for (const k of monthly) {
    s.gpuMonths += k.gpuCount
    s.availableHours += k.availableHours
    s.rentedHours += k.rentedHours
    s.gross += k.grossRevenue
    s.fee += k.fee
    s.net += k.net
    s.downtimeHours += k.downtimeHours
    if (k.includesStaged) s.staged++
  }
  s.gpuCount = monthly.length ? monthly[monthly.length - 1].gpuCount : 0
  return finish(s)
}
