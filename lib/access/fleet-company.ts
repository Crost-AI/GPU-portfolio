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
