// Where each entity stands for one quarter-end: is the quarter closed, has the close been reviewed
// and approved (and by whom), which review checks still need someone, and when its LP reporting is
// due. One read across what the close calendar (close-grid.ts), the close review
// (close.ts / close-approval.ts) and the entity's reporting profile (lib/vehicle-profile.ts)
// already record, so "where are we on Q3" has an answer without the question restating the facts.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadCloseGrid, recentQuarterEnds, type CloseCell } from './close-grid'
import type { FirmEntityScope } from './firm-entities'
import { quarterLabel } from './attention'
import { EMPTY_PROFILE, loadVehicleProfiles, lpReportingDueDate, type VehicleProfile } from '@/lib/vehicle-profile'

export type ReviewStatus = 'prepared' | 'approved' | 'reopened' | 'none'

export interface CloseStatusCheck {
  label: string
  section: string
  status: 'needs_review' | 'blocked'
  detail: string | null
}

export interface EntityCloseStatus {
  vehicleId: string
  vehicle: string
  kind: string | null
  /** closed, reopened, late, due (still within its grace), none (the books do not reach it). */
  close: CloseCell
  review: ReviewStatus
  preparedBy: string | null
  approvedBy: string | null
  approvedAt: string | null
  /** Review checks that are not passed or not applicable, in the review's order. */
  openChecks: CloseStatusCheck[]
  profile: VehicleProfile
  lpReportingDue: string | null
  daysUntilLpReporting: number | null
}

export interface CloseStatus {
  quarterEnd: string
  label: string
  /** The quarter-ends this can answer for, oldest first. */
  available: string[]
  entities: EntityCloseStatus[]
}

const DAY = 86_400_000
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY)

/** Display names for member ids, from auth, as the audit trail reads them. An unknown id stays an id. */
async function memberNames(admin: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  await Promise.all(Array.from(new Set(ids)).map(async id => {
    try {
      const { data } = await admin.auth.admin.getUserById(id)
      const u = data?.user
      if (u) names.set(id, (u.user_metadata?.full_name as string | undefined) || u.email || id)
    } catch { /* stays an id */ }
  }))
  return names
}

export async function loadCloseStatus(
  admin: SupabaseClient,
  fundId: string,
  opts: FirmEntityScope & { quarterEnd?: string; vehicle?: string },
  today = new Date(),
): Promise<CloseStatus | { error: string }> {
  const available = recentQuarterEnds(today)
  const quarterEnd = opts.quarterEnd ?? available[available.length - 1]
  const index = available.indexOf(quarterEnd)
  if (index < 0) return { error: `quarter_end must be one of the last ${available.length} quarter-ends: ${available.join(', ')}` }

  const grid = await loadCloseGrid(admin, fundId, opts, today)
  const wanted = opts.vehicle?.trim().toLowerCase()
  const rows = wanted ? grid.rows.filter(r => r.name.toLowerCase() === wanted) : grid.rows
  if (wanted && rows.length === 0) return { error: `No entity named "${opts.vehicle}" that you can see.` }
  const ids = rows.map(r => r.id)
  if (ids.length === 0) return { quarterEnd, label: quarterLabel(quarterEnd), available, entities: [] }

  // The period that covers the quarter-end, per entity, and its review.
  const { data: periods, error: pErr } = await (admin as any).from('fiscal_periods')
    .select('id, vehicle_id, period_start, period_end, status')
    .eq('fund_id', fundId).in('vehicle_id', ids)
    .lte('period_start', quarterEnd).gte('period_end', quarterEnd)
  if (pErr) throw new Error(`fiscal_periods read failed: ${pErr.message}`)
  const periodByVehicle = new Map<string, any>()
  for (const p of (periods as any[]) ?? []) {
    // A closed period wins over a reopened one covering the same day.
    const prior = periodByVehicle.get(p.vehicle_id)
    if (!prior || (prior.status !== 'closed' && p.status === 'closed')) periodByVehicle.set(p.vehicle_id, p)
  }
  const periodIds = Array.from(periodByVehicle.values()).map(p => p.id as string)

  const { data: reviews, error: rErr } = periodIds.length === 0 ? { data: [], error: null } : await (admin as any).from('close_reviews')
    .select('id, fiscal_period_id, status, prepared_by, approved_by, approved_at')
    .eq('fund_id', fundId).in('fiscal_period_id', periodIds)
  if (rErr) throw new Error(`close_reviews read failed: ${rErr.message}`)
  const reviewByPeriod = new Map(((reviews as any[]) ?? []).map(r => [r.fiscal_period_id as string, r]))
  const reviewIds = ((reviews as any[]) ?? []).map(r => r.id as string)

  const { data: checks, error: cErr } = reviewIds.length === 0 ? { data: [], error: null } : await (admin as any).from('close_review_checks')
    .select('close_review_id, section, label, status, detail, sort_order')
    .in('close_review_id', reviewIds).in('status', ['needs_review', 'blocked'])
  if (cErr) throw new Error(`close_review_checks read failed: ${cErr.message}`)
  const checksByReview = new Map<string, any[]>()
  for (const c of (checks as any[]) ?? []) {
    const list = checksByReview.get(c.close_review_id) ?? []
    list.push(c)
    checksByReview.set(c.close_review_id, list)
  }

  const [profiles, names] = await Promise.all([
    loadVehicleProfiles(admin, fundId, ids),
    memberNames(admin, ((reviews as any[]) ?? []).flatMap(r => [r.prepared_by, r.approved_by]).filter(Boolean)),
  ])
  const todayIso = today.toISOString().slice(0, 10)
  const name = (id: string | null | undefined) => (id ? names.get(id) ?? id : null)

  const entities = rows.map((row): EntityCloseStatus => {
    const period = periodByVehicle.get(row.id)
    const review = period ? reviewByPeriod.get(period.id) : undefined
    const profile = profiles.get(row.id) ?? EMPTY_PROFILE
    const due = lpReportingDueDate(profile, quarterEnd)
    const open = review ? (checksByReview.get(review.id) ?? []).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)) : []
    return {
      vehicleId: row.id,
      vehicle: row.name,
      kind: row.kind,
      close: row.cells[index],
      review: (review?.status as ReviewStatus | undefined) ?? 'none',
      preparedBy: name(review?.prepared_by),
      approvedBy: name(review?.approved_by),
      approvedAt: review?.approved_at ?? null,
      openChecks: open.map(c => ({ label: c.label, section: c.section, status: c.status, detail: c.detail ?? null })),
      profile,
      lpReportingDue: due,
      daysUntilLpReporting: due ? daysBetween(todayIso, due) : null,
    }
  })
  return { quarterEnd, label: quarterLabel(quarterEnd), available, entities }
}
