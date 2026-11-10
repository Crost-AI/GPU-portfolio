import type { SupabaseClient } from '@supabase/supabase-js'
import type { SettlementReview } from './settlement'

export async function loadSettlementReviews(admin: SupabaseClient, fundId: string, vehicleId: string | null, kind: 'call' | 'distribution'): Promise<SettlementReview[]> {
  if (!vehicleId) return []
  const { data, error } = await admin.from('capital_settlement_reviews' as any)
    .select('line_id, manual_amount, manual_date, links, separate_remainder')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('kind', kind)
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({ lineId: row.line_id, manualAmount: Number(row.manual_amount), manualDate: row.manual_date, links: row.links, separateRemainder: row.separate_remainder }))
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface SettlementReviewInput {
  kind: 'call' | 'distribution'
  /** The capital-call or distribution line the payments settle. */
  lineId: string
  /** Journal entries (wires) that pay it, and how much of each. */
  links: { entryId: string; amount: number }[]
  /** Leave any remainder of a wire as a separate payment rather than folding it into this line. */
  separateRemainder: boolean
}

/** Why a settlement decision is malformed, or null. A bounded list: the RPC locks per link. */
export function settlementReviewProblem(body: any): string | null {
  if (!body || !['call', 'distribution'].includes(body.kind) || !UUID.test(body.lineId ?? '') || !Array.isArray(body.links)
    || body.links.length > 50 || typeof body.separateRemainder !== 'boolean'
    || body.links.some((link: any) => !UUID.test(link?.entryId ?? '') || typeof link.amount !== 'number' || !Number.isFinite(link.amount) || link.amount <= 0)) {
    return 'Choose valid payment links and amounts'
  }
  return null
}

/**
 * Record how wires settle one call or distribution line: the settlements page's review, shared with
 * the agent's review_capital_settlement tool. The RPC serialises decisions per partner.
 */
export async function reviewCapitalSettlement(
  admin: SupabaseClient, fundId: string, vehicleId: string, userId: string | null, body: SettlementReviewInput,
): Promise<{ ok: true } | { error: string; status: number }> {
  const problem = settlementReviewProblem(body)
  if (problem) return { error: problem, status: 400 }
  const { error } = await admin.rpc('review_capital_settlement' as any, {
    p_fund_id: fundId, p_vehicle_id: vehicleId, p_kind: body.kind, p_line_id: body.lineId,
    p_links: body.links, p_separate: body.separateRemainder, p_user_id: userId,
  })
  if (error) return { error: error.message, status: 409 }
  return { ok: true }
}
