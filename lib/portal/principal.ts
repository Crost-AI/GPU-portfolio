/**
 * Who is asking at the investor connector (app/api/portal/mcp), and whether they may.
 *
 * An investor connects ONE fund: the token is bound to it at consent, like a fund member's. Their
 * investor ids are narrowed to that fund here, so every portal function (lib/portal/service.ts)
 * sees only that fund's investors, even for an LP who also invests in another fund on this
 * deployment.
 *
 * Re-checked on every call, never baked into the token: the LP account still active, the fund's
 * LP portal still on, and the fund's investor connector still on. Turning either switch off, or
 * disabling the LP, cuts off a connected assistant on its next call.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { resolveLpAccess } from '@/lib/api-helpers'
import type { LpPrincipal } from './service'

/** The fund's investor connector is usable: the LP portal on, and the connector switched on. */
export async function lpConnectorEnabled(admin: SupabaseClient, fundId: string): Promise<boolean> {
  const { data } = await (admin as any)
    .from('fund_settings').select('lp_portal_enabled, lp_agent_enabled').eq('fund_id', fundId).maybeSingle()
  return !!data?.lp_portal_enabled && !!data?.lp_agent_enabled
}

export interface ConnectableFund { fundId: string; name: string; connectorOn: boolean }

/**
 * The funds this signed-in person invests in through an active LP account, with whether each
 * fund's connector is on. Null when they have no active LP account.
 */
export async function lpFundsFor(admin: SupabaseClient, userId: string): Promise<{ lpAccountId: string; funds: ConnectableFund[] } | null> {
  const access = await resolveLpAccess(admin, userId)
  if (access instanceof NextResponse) return null
  if (access.investorIds.length === 0) return { lpAccountId: access.lpAccountId, funds: [] }
  const db = admin as any
  const { data: inv } = await db.from('lp_investors').select('fund_id').in('id', access.investorIds)
  const fundIds = Array.from(new Set(((inv ?? []) as any[]).map(r => r.fund_id as string)))
  if (fundIds.length === 0) return { lpAccountId: access.lpAccountId, funds: [] }
  const [{ data: funds }, { data: settings }] = await Promise.all([
    db.from('funds').select('id, name').in('id', fundIds),
    db.from('fund_settings').select('fund_id, lp_portal_enabled, lp_agent_enabled').in('fund_id', fundIds),
  ])
  const on = new Set(((settings ?? []) as any[]).filter(s => s.lp_portal_enabled && s.lp_agent_enabled).map(s => s.fund_id as string))
  const name = new Map<string, string>(((funds ?? []) as any[]).map(f => [f.id as string, f.name as string]))
  return {
    lpAccountId: access.lpAccountId,
    funds: fundIds
      .map(fundId => ({ fundId, name: name.get(fundId) ?? 'Your fund', connectorOn: on.has(fundId) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/**
 * The principal for a connector call: the LP's live access, narrowed to the token's fund. Null
 * when the account is no longer active or no longer invests in that fund.
 */
export async function connectorPrincipal(
  admin: SupabaseClient, userId: string, fundId: string, email?: string | null,
): Promise<LpPrincipal | null> {
  const access = await resolveLpAccess(admin, userId)
  if (access instanceof NextResponse) return null
  if (access.investorIds.length === 0) return null
  const { data: inv } = await (admin as any).from('lp_investors').select('id').eq('fund_id', fundId).in('id', access.investorIds)
  const investorIds = ((inv ?? []) as any[]).map(r => r.id as string)
  if (investorIds.length === 0) return null
  return { userId, email: email ?? null, lpAccountId: access.lpAccountId, investorIds }
}

/** An investor's grant is read, or read and act (acknowledge a wire, message the fund). */
export function lpGrantableScope(requested: string | null | undefined): string {
  return String(requested ?? '').split(/[\s,]+/).includes('write') ? 'read write' : 'read'
}
