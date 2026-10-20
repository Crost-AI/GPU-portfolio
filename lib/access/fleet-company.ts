// ── GPU fleet (P3) ── A GPU SPV's fleet company (holding_type 'gpu_fleet') and its metrics are the
// SPV's revenue restated, so they need `fleet` as well as `portfolio` (issue #91). RLS enforces it
// for the Data API (20261019310000); this is the same rule for the routes and the page, which read
// with the service role.
//
// Not found rather than 403: the caller may not know the fleet company exists, and a refusal that
// says what it is would be the leak (the rule assertVehicleKind follows).

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hasAccess, loadAccessContext, type AccessContext } from './effective'

export const FLEET_HOLDING_TYPE = 'gpu_fleet'

/** Whether a holding of this kind is hidden from this caller at this level. */
export function fleetCompanyDenied(access: AccessContext, holdingType: string | null | undefined, need: 'read' | 'write' = 'read'): boolean {
  return holdingType === FLEET_HOLDING_TYPE && !hasAccess(access, 'fleet', need)
}

export type FleetCompanyRef = { companyId: string } | { metricId: string } | { metricValueId: string }

const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 })

/**
 * A 404 when `ref` is (or belongs to) a fleet company the caller may not reach at `need`; null
 * otherwise, including when nothing is found (the route answers that itself). Any other company
 * costs one read of its holding_type and nothing else.
 */
export async function refuseFleetCompany(
  admin: SupabaseClient, userId: string, ref: FleetCompanyRef, need: 'read' | 'write' = 'read',
): Promise<NextResponse | null> {
  let companyId: string | null = 'companyId' in ref ? ref.companyId : null
  if ('metricId' in ref) {
    const { data } = await (admin as any).from('metrics').select('company_id').eq('id', ref.metricId).maybeSingle()
    companyId = data?.company_id ?? null
  } else if ('metricValueId' in ref) {
    const { data } = await (admin as any).from('metric_values').select('company_id').eq('id', ref.metricValueId).maybeSingle()
    companyId = data?.company_id ?? null
  }
  if (!companyId) return null
  const { data: company, error } = await (admin as any).from('companies').select('fund_id, holding_type').eq('id', companyId).maybeSingle()
  if (error) return NextResponse.json({ error: 'Could not read the company. Try again.' }, { status: 500 })
  if (!company || company.holding_type !== FLEET_HOLDING_TYPE) return null

  const { data: member } = await (admin as any).from('fund_members').select('role')
    .eq('fund_id', company.fund_id).eq('user_id', userId).maybeSingle()
  if (!member) return notFound()
  const access = await loadAccessContext(admin, company.fund_id, userId, member.role)
  return fleetCompanyDenied(access, company.holding_type, need) ? notFound() : null
}

/**
 * A reader's visible company set without the fleet companies this caller may not read: what the
 * company-updates search and the agent's get_updates pass on instead of their bare scope. `visible`
 * null = every company in the fund; when the fund has a hidden fleet company that becomes the
 * explicit list of every other company — an internal scope, applied after the request is parsed
 * (scopeSearchParams), so it can exceed the 200-id cap on a requested company_ids list. A fund
 * without a fleet company costs one read and returns `visible` unchanged.
 */
export async function withoutHiddenFleet(
  admin: SupabaseClient, fundId: string, access: AccessContext | null | undefined, visible: string[] | null,
): Promise<string[] | null> {
  const { data: fleetRows, error } = await (admin as any).from('companies').select('id')
    .eq('fund_id', fundId).eq('holding_type', FLEET_HOLDING_TYPE)
  if (error) throw error
  const fleet = ((fleetRows as any[]) ?? []).map(r => r.id as string)
  if (!fleet.length || (access && !fleetCompanyDenied(access, FLEET_HOLDING_TYPE, 'read'))) return visible
  const hidden = new Set(fleet)
  if (visible !== null) return visible.filter(id => !hidden.has(id))
  const all: string[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error: pageError } = await (admin as any).from('companies').select('id')
      .eq('fund_id', fundId).order('id').range(from, from + 999)
    if (pageError) throw pageError
    const rows = (data as any[]) ?? []
    for (const r of rows) if (!hidden.has(r.id)) all.push(r.id)
    if (rows.length < 1000) break
  }
  return all
}

/**
 * The fund's fleet companies this caller may not read: every one of them, or none. Empty — after one
 * read — for a fund with no fleet company, so a VC fund's lists take the path they always took.
 */
export async function hiddenFleetIdsInFund(admin: SupabaseClient, fundId: string, userId: string): Promise<Set<string>> {
  const { data, error } = await (admin as any).from('companies').select('id')
    .eq('fund_id', fundId).eq('holding_type', FLEET_HOLDING_TYPE)
  if (error) throw error
  const fleet = ((data as any[]) ?? []).map(r => r.id as string)
  if (!fleet.length) return new Set()
  const { data: member } = await (admin as any).from('fund_members').select('role').eq('fund_id', fundId).eq('user_id', userId).maybeSingle()
  if (!member) return new Set(fleet)
  const access = await loadAccessContext(admin, fundId, userId, member.role)
  return fleetCompanyDenied(access, FLEET_HOLDING_TYPE, 'read') ? new Set(fleet) : new Set()
}

/** Most rows a hidden-fleet list reads before it returns what it has: bounds the reads one request can cause. */
export const FLEET_HIDDEN_SCAN_CAP = 5000
/** PostgREST's max_rows: a page never asks for more, so a short page always means the end. */
const MAX_PAGE = 1000

/**
 * The size of page `index` of a list that skips hidden rows: at least 200 whatever the caller's
 * limit, doubling each page up to max_rows, and never past the scan cap.
 */
export function fleetPageSize(minRows: number, index: number, scanned: number): number {
  return Math.max(1, Math.min(Math.max(minRows, 200) * 2 ** index, MAX_PAGE, FLEET_HIDDEN_SCAN_CAP - scanned))
}

/**
 * The first `limit` rows of an ordered query that are not about a hidden company — paging past
 * hidden rows, so they never crowd visible ones out of the limit and the order is kept. `page(from,
 * to)` builds the full query (filters and order, with a unique tie-break) plus `.range(from, to)`.
 * Reads at most FLEET_HIDDEN_SCAN_CAP rows, then returns what it has.
 */
export async function firstVisibleRows<T extends { company_id?: string | null }>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>, limit: number, hidden: Set<string>,
): Promise<{ data: T[]; error: any }> {
  const out: T[] = []
  let scanned = 0
  for (let i = 0; out.length < limit && scanned < FLEET_HIDDEN_SCAN_CAP; i++) {
    const size = fleetPageSize(limit, i, scanned)
    const { data, error } = await page(scanned, scanned + size - 1)
    if (error) return { data: out, error }
    const rows = data ?? []
    scanned += rows.length
    for (const r of rows) {
      if (r.company_id && hidden.has(r.company_id)) continue
      out.push(r)
      if (out.length === limit) break
    }
    if (rows.length < size) break
  }
  return { data: out, error: null }
}
