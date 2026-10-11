// A plan's portfolio construction (plans/plan-unified-plan.md, phase 1).
//
// Each forecast plan — budgets included — holds its own construction assumptions: the deals, exits,
// reserves and pacing its scenario assumes. One plan per entity is PRIMARY: the one an entity's
// headline figures, a management company's fee income and a GP entity's share are read from.
//
// fund_construction_models is the SEED (read through the construction service, which owns it). A plan
// whose construction has not been copied yet reads the entity's row from there; the first save copies it onto the plan (and onto every other plan of the
// entity still without one), and the table is not written again. Nothing here writes on a read.
//
// No access checks here: callers (the construction and forecast services) have already resolved
// the vehicle against the caller's access.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface PlanConstructionRef {
  /** The plan the construction belongs to; null when the entity has no plan yet. */
  planId: string | null
  planName: string | null
  isPrimary: boolean
  /** Raw assumptions (validated by the caller); null = none anywhere (use defaults). */
  assumptions: Record<string, unknown> | null
  /** Where the assumptions came from. */
  source: 'plan' | 'seed' | 'none'
}

/** The plan marked primary for an entity, if one is. */
async function markedPrimaryRow(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<any | null> {
  const { data } = await (admin as any).from('forecast_plans').select('id, name, construction, is_primary, revision, kind, status')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('is_primary', true).maybeSingle()
  return data ?? null
}

/**
 * The entity's primary plan: the one marked, else — when it has plans but none is marked yet (plans
 * made before plans had a primary) — the one that would be picked: its first active rolling
 * forecast, else its first active plan, else its first. Read only; marking is pickPrimaryPlan's.
 */
export async function primaryPlanRow(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<any | null> {
  const marked = await markedPrimaryRow(admin, fundId, vehicleId)
  if (marked) return marked
  const { data } = await (admin as any).from('forecast_plans').select('id, name, construction, is_primary, revision, kind, status, created_at')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).order('created_at', { ascending: true })
  const rows = (data as any[]) ?? []
  return rows.find(r => r.status === 'active' && r.kind === 'rolling_forecast') ?? rows.find(r => r.status === 'active') ?? rows[0] ?? null
}

/**
 * The construction a plan computes from: the named plan's, else the primary plan's, else the seed.
 * A plan that has not been given its own yet reads the seed — so before anyone saves, every surface
 * shows exactly what construction showed before plans held it.
 */
export async function loadPlanConstruction(
  admin: SupabaseClient, fundId: string, vehicleId: string, planId: string | null | undefined,
  /** The entity's seed — read by the construction service, which owns that table. */
  loadSeed: () => Promise<Record<string, unknown> | null>,
): Promise<PlanConstructionRef> {
  let row: any = null
  if (planId) {
    const { data } = await (admin as any).from('forecast_plans').select('id, name, construction, is_primary')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('id', planId).maybeSingle()
    if (!data) throw new Error('That plan is not one of this entity\'s.')
    row = data
  } else {
    row = await primaryPlanRow(admin, fundId, vehicleId)
  }
  if (row?.construction) {
    return { planId: row.id, planName: row.name, isPrimary: !!row.is_primary, assumptions: row.construction, source: 'plan' }
  }
  const seed = await loadSeed()
  return { planId: row?.id ?? null, planName: row?.name ?? null, isPrimary: !!row?.is_primary, assumptions: seed, source: seed ? 'seed' : 'none' }
}

/**
 * Write a plan's construction, bumping its revision (the forecast's concurrency guard) so an open
 * forecast reloads rather than saving over it. The plan's compiled draft is now out of date; the
 * forecast's staleness check (sources fingerprint) offers Refresh.
 */
export async function writePlanConstruction(
  admin: SupabaseClient, fundId: string, planId: string, assumptions: Record<string, unknown>,
): Promise<void> {
  const { data: cur, error: readErr } = await (admin as any).from('forecast_plans').select('revision').eq('fund_id', fundId).eq('id', planId).single()
  if (readErr) throw new Error(readErr.message)
  const { data, error } = await (admin as any).from('forecast_plans')
    .update({ construction: assumptions, revision: Number(cur.revision) + 1, updated_at: new Date().toISOString() })
    .eq('fund_id', fundId).eq('id', planId).eq('revision', cur.revision).select('id')
  if (error) throw new Error(error.message)
  if (!data?.length) throw new Error('The plan changed while saving — reload and try again.')
}

/**
 * Give every plan of an entity that has no construction of its own a copy of `assumptions` — the
 * one-time move off fund_construction_models, done when the entity's construction is first saved.
 */
export async function copyConstructionToPlansWithout(
  admin: SupabaseClient, fundId: string, vehicleId: string, assumptions: Record<string, unknown>, exceptPlanId?: string,
): Promise<number> {
  let q = (admin as any).from('forecast_plans').update({ construction: assumptions })
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).is('construction', null)
  if (exceptPlanId) q = q.neq('id', exceptPlanId)
  const { data, error } = await q.select('id')
  if (error) throw new Error(error.message)
  return data?.length ?? 0
}

/** Make `planId` the entity's primary plan (and no other). */
export async function setPrimaryPlan(admin: SupabaseClient, fundId: string, vehicleId: string, planId: string): Promise<void> {
  // Clear first: the partial unique index allows one primary per entity at any moment.
  const { error: clearErr } = await (admin as any).from('forecast_plans').update({ is_primary: false })
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('is_primary', true).neq('id', planId)
  if (clearErr) throw new Error(clearErr.message)
  const { error } = await (admin as any).from('forecast_plans').update({ is_primary: true })
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('id', planId)
  if (error) throw new Error(error.message)
}

/**
 * The entity's primary plan, choosing one when it has plans but none is marked: its first active
 * rolling forecast, else its first plan. Returns null when it has no plans at all — creating one is
 * the forecast service's job (it compiles), see ensurePrimaryPlan in service.ts.
 */
export async function pickPrimaryPlan(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<string | null> {
  const existing = await markedPrimaryRow(admin, fundId, vehicleId)
  if (existing) return existing.id
  const { data } = await (admin as any).from('forecast_plans').select('id, kind, status, created_at')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).order('created_at', { ascending: true })
  const rows = (data as any[]) ?? []
  const pick = rows.find(r => r.status === 'active' && r.kind === 'rolling_forecast') ?? rows.find(r => r.status === 'active') ?? rows[0]
  if (!pick) return null
  await setPrimaryPlan(admin, fundId, vehicleId, pick.id)
  return pick.id
}
