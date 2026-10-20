// Resolve each parsed operations row to a server in the register, and fill in whichever of rented
// hours / utilization % was not typed. Pure apart from hashing.

import { createHash } from 'node:crypto'
import { daysInclusive } from '../kpis'
import type { GpuAssetRow } from '../types'
import type { ParsedEarning } from './parse'

export type MatchAsset = Pick<GpuAssetRow, 'id' | 'name' | 'serials' | 'gpu_count'> & { disposed_on?: string | null }

export interface MatchedEarning extends ParsedEarning {
  /** Null = no server answers to `assetRef`: the row is kept as `unmatched`. */
  assetId: string | null
  assetName: string | null
  /** Both set on a matched row; on an unmatched row only the one that was typed. */
  gpuHoursRented: number | null
  utilizationPct: number | null
  status: 'staged' | 'unmatched'
}

export interface MatchOutcome {
  rows: MatchedEarning[]
  errors: string[]
  unmatched: number
}

const key = (s: string) => s.trim().toLowerCase()
const round4 = (n: number) => Math.round(n * 10_000) / 10_000

/** GPU-hours a server can sell over a period: every GPU, every hour. */
export function capacityHours(gpuCount: number, start: string, end: string): number {
  return gpuCount * 24 * daysInclusive(start, end)
}

/** Exact name (case-insensitive, trimmed), then a serial number, then the id. */
export function findAsset(ref: string, assets: MatchAsset[]): MatchAsset | null {
  const k = key(ref)
  return assets.find(a => key(a.name) === k)
    ?? assets.find(a => (a.serials ?? []).some(s => key(s) === k))
    ?? assets.find(a => key(a.id) === k)
    ?? null
}

/**
 * The idempotency key for one row: the vehicle, what was typed for the asset, the period, every
 * figure, and `occurrence` — the row's count among identical rows earlier in the same paste, as the
 * bank import does — so a re-paste of the same rows is recognised and skipped.
 *
 * Every figure, not just gross: a correction to the hours or the downtime alone is a different row
 * (it updates the staged one), not a duplicate.
 */
export function dedupHash(vehicleId: string, row: ParsedEarning, occurrence = 0): string {
  const figures = [row.rentedHours, row.utilizationPct, row.gross, row.fee, row.net, row.downtimeHours].map(v => (v == null ? '' : String(v)))
  const s = [vehicleId, key(row.assetRef), row.periodStart, row.periodEnd, ...figures, String(occurrence)].join('|')
  return createHash('sha256').update(s).digest('hex')
}

/**
 * Match each row to a server and derive the missing one of rented hours / utilization from its GPU
 * count. Refused (an error, not a row): rented or downtime hours above what the server has in the
 * period, a period starting after the server was disposed of, and a second row for the same server
 * and period in one paste.
 */
export function matchAssets(parsed: ParsedEarning[], assets: MatchAsset[]): MatchOutcome {
  const out: MatchOutcome = { rows: [], errors: [], unmatched: 0 }
  const seen = new Set<string>()
  for (const p of parsed) {
    const asset = findAsset(p.assetRef, assets)
    if (!asset) {
      out.unmatched++
      out.rows.push({ ...p, assetId: null, assetName: null, gpuHoursRented: p.rentedHours, utilizationPct: p.utilizationPct, status: 'unmatched' })
      continue
    }
    // A disposed server still earns for its last periods; not for one starting after it left.
    if (asset.disposed_on && p.periodStart > asset.disposed_on) {
      out.errors.push(`Row ${p.line}: ${asset.name} was disposed of on ${asset.disposed_on}, before this period starts`)
      continue
    }
    const period = `${asset.id}|${p.periodStart}|${p.periodEnd}`
    if (seen.has(period)) {
      out.errors.push(`Row ${p.line}: ${asset.name} ${p.periodStart}..${p.periodEnd} appears twice in this paste`)
      continue
    }
    const capacity = capacityHours(asset.gpu_count, p.periodStart, p.periodEnd)
    const rented = p.rentedHours ?? round4((p.utilizationPct! / 100) * capacity)
    if (rented > capacity + 1e-9) {
      out.errors.push(`Row ${p.line}: ${rented} rented GPU-hours is more than ${asset.name} can sell in the period (${asset.gpu_count} GPUs × ${capacity / asset.gpu_count} h = ${capacity})`)
      continue
    }
    if (p.downtimeHours > capacity + 1e-9) {
      out.errors.push(`Row ${p.line}: ${p.downtimeHours} downtime GPU-hours is more than ${asset.name} has in the period (${capacity})`)
      continue
    }
    seen.add(period)
    const utilization = p.utilizationPct ?? round4((rented / capacity) * 100)
    out.rows.push({ ...p, assetId: asset.id, assetName: asset.name, gpuHoursRented: rented, utilizationPct: utilization, status: 'staged' })
  }
  return out
}
