// Make imported partners visible to accounting.
//
// The positions import (app/api/accounting/positions/import) writes lp_positions — the dated
// capital-tracking history — but the accounting side finds a vehicle's partners through
// `lp_investments` (portfolio_group = vehicle name): vehicleStatus via loadOwnership /
// loadEntityNames, opening balances (/api/accounting/entities), allocation, capital calls. A fund
// whose LPs came in only by the importer therefore read "No partners yet". This gives each
// imported entity the same lp_investments row the accounting Add-LP path
// (app/api/accounting/lps POST) would have created for it.
//
// Semantics, chosen to match that path where it applies and to be safe where it doesn't:
//   * One row per (fund, entity, vehicle), any snapshot. An entity that already has a row for the
//     vehicle — in any report, or unsnapshotted — is left alone. Re-importing never duplicates.
//   * Existing rows are NOT updated. Accounting/lps does overwrite the commitment, but there a
//     person typed the figure for this partner just now. Here the paste is dated: re-pasting an
//     older as-of must not roll a commitment back, a row inside an LP report carries that
//     report's figures (and is locked once shared), and the import's commitment already lives in
//     lp_positions + commitment_events. Commitment changes go through the commitment-events flow.
//   * New rows carry only the commitment, as accounting/lps does — called / distributed / NAV
//     stay in lp_positions, which is what capital tracking reads.
//   * Snapshot: the fund's latest report, as accounting/lps chooses, so the partner also shows in
//     LP reporting — unless that report is shared with investors. A shared report is locked
//     (supabase/migrations/20261010200002_lock_shared_lp_reports.sql and its insert extension),
//     so then the row is unsnapshotted, which loadOwnership reads as the fallback.

import type { SupabaseClient } from '@supabase/supabase-js'
import { reportShareCount } from '@/lib/lps/shared-lock'

export interface EnsureInvestmentsResult {
  created: number
  snapshotId: string | null
}

/** The snapshot a new lp_investments row may join: the latest report, or null if it is shared. */
export async function unsharedLatestSnapshot(admin: SupabaseClient, fundId: string): Promise<string | null> {
  const { data: snap } = await (admin as any).from('lp_snapshots').select('id')
    .eq('fund_id', fundId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  const id = (snap as { id?: string } | null)?.id ?? null
  if (!id) return null
  return (await reportShareCount(admin, fundId, id)) > 0 ? null : id
}

/**
 * Ensure every entity in `commitmentByEntity` has an lp_investments row for `group`.
 * `commitmentByEntity` maps entity id → the commitment to seed a NEW row with (null → 0).
 */
export async function ensureVehicleInvestments(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  commitmentByEntity: Map<string, number | null>,
): Promise<EnsureInvestmentsResult> {
  const ids = Array.from(commitmentByEntity.keys())
  if (ids.length === 0) return { created: 0, snapshotId: null }

  const { data: existing, error: readErr } = await (admin as any).from('lp_investments').select('entity_id')
    .eq('fund_id', fundId).eq('portfolio_group', group).in('entity_id', ids)
  if (readErr) throw new Error(readErr.message ?? 'Could not read LP investments')
  const have = new Set(((existing as { entity_id: string }[]) ?? []).map(r => r.entity_id))

  const missing = ids.filter(id => !have.has(id))
  if (missing.length === 0) return { created: 0, snapshotId: null }

  const snapshotId = await unsharedLatestSnapshot(admin, fundId)
  const rows = missing.map(id => ({
    fund_id: fundId,
    entity_id: id,
    portfolio_group: group,
    commitment: commitmentByEntity.get(id) ?? 0,
    snapshot_id: snapshotId,
  }))
  const { error } = await (admin as any).from('lp_investments').insert(rows)
  if (error) throw new Error(error.message ?? 'Could not create LP investments')
  return { created: rows.length, snapshotId }
}
