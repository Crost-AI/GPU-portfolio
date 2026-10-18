// Stage manual GPU operations entry: parse → match → dedup → insert. Never posts (post.ts does).
//
// Everything is per vehicle. Callers (the /api/fleet/ops routes) have already resolved the group and
// checked `fleet`; this re-checks that the vehicle is a GPU SPV so no other caller can stage revenue
// on a fund's books.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ImportResult } from '@/lib/accounting/bank-import'
import { fetchAllRows } from '@/lib/accounting/load'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { vehicleKindByName } from '@/lib/accounting/vehicle-domain'
import { dedupHash, matchAssets, type MatchAsset, type MatchedEarning } from './match'
import { parseEarningsCsv, parseManualRows, type ManualRow } from './parse'
import type { EarningRow } from './types'

/** The GPU SPV's id, or the refusal: an unknown vehicle, or one that is not a GPU SPV. */
export async function fleetVehicleId(admin: SupabaseClient, fundId: string, group: string): Promise<{ vehicleId: string } | { error: string }> {
  if ((await vehicleKindByName(admin, fundId, group)) !== 'gpu_spv') return { error: 'Vehicle not found' }
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  return vehicleId ? { vehicleId } : { error: 'Vehicle not found' }
}

/** Servers that can earn: in service, or offline for part of a period. */
const EARNING_STATUSES = ['in_service', 'offline']

export type ImportInput = { rows: ManualRow[]; csv?: undefined; fileName?: string } | { csv: string; rows?: undefined; fileName?: string }

export type EarningsImport = ImportResult & { runId: string; staged: EarningRow[] }

const periodKey = (assetId: string | null, start: string, end: string) => `${assetId}|${start}|${end}`
const label = (r: MatchedEarning) => `Row ${r.line}: ${r.assetName ?? r.assetRef} ${r.periodStart}..${r.periodEnd}`

function figures(r: MatchedEarning) {
  return {
    asset_ref: r.assetRef, period_start: r.periodStart, period_end: r.periodEnd,
    gpu_hours_rented: r.gpuHoursRented, utilization_pct: r.utilizationPct,
    gross: r.gross, marketplace_fee: r.fee, net: r.net, downtime_hours: r.downtimeHours,
    note: r.note, raw: r.raw,
  }
}

/**
 * Stage rows from the entry form (`rows`) or a CSV paste (`csv`). Per row, against the vehicle's
 * existing entries:
 *   - the identical row (same hash) is already there, in any status → skipped, with the reason;
 *   - the same server and period is STAGED with other figures → that row is updated in place;
 *   - the same server and period is POSTED with other figures → a new staged row that supersedes
 *     it (needsReview: posting it reverses the posted entry first);
 *   - otherwise a new row: staged, or unmatched when no server answers to the name.
 * A period inside a closed period is refused when posting, not here.
 */
export async function importEarnings(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null, input: ImportInput,
): Promise<EarningsImport | { error: string; errors?: string[] }> {
  const vehicle = await fleetVehicleId(admin, fundId, group)
  if ('error' in vehicle) return vehicle
  const { vehicleId } = vehicle

  const source = typeof input.csv === 'string' ? 'csv' : 'manual'
  const parsed = source === 'csv' ? parseEarningsCsv(input.csv!) : parseManualRows(input.rows ?? [])
  if (parsed.rows.length === 0) return { error: parsed.errors[0] ?? 'Nothing to import', errors: parsed.errors }

  const assets = await fetchAllRows<MatchAsset & { status: string }>((f, t) => (admin as any).from('gpu_assets')
    .select('id, name, serials, gpu_count, status').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    .in('status', EARNING_STATUSES).range(f, t))
  const matched = matchAssets(parsed.rows, assets)

  const existing = await fetchAllRows<Pick<EarningRow, 'id' | 'asset_id' | 'period_start' | 'period_end' | 'status' | 'dedup_hash'>>((f, t) => (admin as any)
    .from('gpu_earnings').select('id, asset_id, period_start, period_end, status, dedup_hash')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).range(f, t))
  const byHash = new Map(existing.map(e => [e.dedup_hash, e]))
  const staged = new Map(existing.filter(e => e.status === 'staged' && e.asset_id).map(e => [periodKey(e.asset_id, e.period_start, e.period_end), e]))
  const posted = new Map(existing.filter(e => e.status === 'posted' && e.asset_id).map(e => [periodKey(e.asset_id, e.period_start, e.period_end), e]))

  const result: ImportResult = { imported: 0, skipped: 0, matched: 0, needsReview: 0, skippedRows: [], errors: [...parsed.errors, ...matched.errors] }
  const inserts: Record<string, unknown>[] = []
  const updates: { id: string; values: Record<string, unknown> }[] = []
  const occurrences = new Map<string, number>()
  let unmatched = 0

  for (const r of matched.rows) {
    const base = dedupHash(vehicleId, r)
    const n = occurrences.get(base) ?? 0
    occurrences.set(base, n + 1)
    const hash = dedupHash(vehicleId, r, n)
    const same = byHash.get(hash)
    if (same) {
      result.skipped++
      result.skippedRows.push(`${label(r)} is already entered (${same.status})`)
      continue
    }
    const k = periodKey(r.assetId, r.periodStart, r.periodEnd)
    const open = r.assetId ? staged.get(k) : undefined
    if (open) {
      updates.push({ id: open.id, values: { ...figures(r), dedup_hash: hash, updated_at: new Date().toISOString() } })
      result.imported++
      result.matched++
      continue
    }
    const supersedes = r.assetId ? posted.get(k) : undefined
    if (supersedes) result.needsReview++
    if (r.assetId) result.matched++
    else unmatched++
    result.imported++
    inserts.push({
      fund_id: fundId, vehicle_id: vehicleId, asset_id: r.assetId, ...figures(r),
      dedup_hash: hash, status: r.status, supersedes_id: supersedes?.id ?? null, created_by: userId,
    })
  }

  const { data: run, error: runError } = await (admin as any).from('gpu_import_runs').insert({
    fund_id: fundId, vehicle_id: vehicleId, source, file_name: input.fileName ?? null,
    rows_total: parsed.rows.length + parsed.errors.length, rows_imported: result.imported,
    rows_skipped: result.skipped, rows_unmatched: unmatched, created_by: userId,
  }).select('id').single()
  if (runError) return { error: `The import could not be recorded: ${runError.message}` }
  const runId = (run as any).id as string

  const out: EarningRow[] = []
  if (inserts.length) {
    const { data, error } = await (admin as any).from('gpu_earnings').insert(inserts.map(r => ({ ...r, run_id: runId }))).select('*')
    if (error) {
      await (admin as any).from('gpu_import_runs').delete().eq('id', runId).eq('fund_id', fundId)
      return { error: error.code === '23505' ? 'Another import of these rows ran at the same time. Nothing was staged; paste again to see what is new.' : error.message }
    }
    out.push(...((data as EarningRow[]) ?? []))
  }
  for (const u of updates) {
    const { data, error } = await (admin as any).from('gpu_earnings').update({ ...u.values, run_id: runId })
      .eq('id', u.id).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'staged').select('*')
    if (error) return { error: error.message }
    out.push(...((data as EarningRow[]) ?? []))
  }
  return { ...result, runId, staged: out }
}
