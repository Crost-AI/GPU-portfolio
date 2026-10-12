// Reading the books' audit trail back: filtered to what the caller may see, and as CSV.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { hasAccess } from '@/lib/access/effective'
import { fetchAllRows } from '@/lib/accounting/load'
import { stagedAction } from '@/lib/pending-actions/staged'
import { toolCallGate } from '@/lib/agent/tool-call-action'
import { csvField } from '@/lib/csv/escape'

export interface AuditRow {
  id: string
  createdAt: string
  action: string
  subjectType: string
  subjectId: string | null
  vehicleId: string | null
  actorId: string | null
  actorName: string | null
  reason: string | null
  details: Record<string, unknown>
  /** web, api or mcp; null for events recorded before the source was tracked. */
  source: string | null
}

/**
 * Which events a caller may read. The route is gated on `accounting`; events about partners'
 * positions, commitments, registers and reports carry partner figures (`lp_capital`), and K-1
 * events the carry too (`gp_economics`) — the same straddle the statements route gates in-handler.
 *
 * Two more straddles:
 *   - `tax.*` events are the tax module's (`accounting` + feature `tax_reporting`, off by default).
 *   - `pending_action.*` events carry the approved action's full `args`, and an action may belong
 *     to ANY domain (a portfolio metric, an investment, a forecast). They follow that action's own
 *     gate — `getWriteAction(actionType).domain` + `accessFeature` — and an action type the
 *     registry no longer knows is hidden, since nothing says who may see its args. A staged tool
 *     call (`agent_tool_call`) follows its TOOL's gate, read from the args the event carries.
 *   - `agent.*` events are a connected assistant's direct writes and carry the call's input; they
 *     follow the tool's gate the same way, and an unknown tool is hidden.
 */
export function visibleTo(access: AccessContext) {
  const partners = hasAccess(access, 'lp_capital', 'read')
  const carry = hasAccess(access, 'gp_economics', 'read')
  const tax = hasAccess(access, 'accounting', 'read', 'tax_reporting')
  return (action: string, details?: Record<string, unknown> | null) => {
    if (action.startsWith('k1.')) return partners && carry
    if (/^(commitment|lp_position|snapshot|lp_statement|capital_call|distribution)\./.test(action)) return partners
    if (action.startsWith('tax.')) return tax
    if (action.startsWith('pending_action.')) {
      const type = details?.actionType
      const wa = typeof type === 'string' ? stagedAction(type, details?.args) : undefined
      return !!wa && hasAccess(access, wa.domain, 'read', wa.accessFeature)
    }
    if (action.startsWith('agent.')) {
      const gate = toolCallGate({ tool: details?.tool, input: details?.input })
      return !!gate && hasAccess(access, gate.domain, 'read', gate.accessFeature)
    }
    return true
  }
}

export async function loadAuditTrail(
  admin: SupabaseClient,
  fundId: string,
  opts: { vehicleId?: string | null; from?: string | null; to?: string | null; limit?: number },
  allowed: (action: string, details?: Record<string, unknown> | null, vehicleId?: string | null) => boolean,
): Promise<AuditRow[]> {
  const rows = await fetchAllRows<any>((f, t) => {
    let q = (admin as any).from('accounting_audit_events').select('*').eq('fund_id', fundId)
    if (opts.vehicleId) q = q.eq('vehicle_id', opts.vehicleId)
    if (opts.from) q = q.gte('created_at', opts.from)
    if (opts.to) q = q.lte('created_at', `${opts.to}T23:59:59.999Z`)
    return q.order('created_at', { ascending: false }).range(f, t)
  })
  const kept = rows.filter(r => allowed(r.action, r.details ?? null, r.vehicle_id ?? null)).slice(0, opts.limit ?? Infinity)
  // Names, not ids, for the people — the trail is read by an auditor, not a database.
  const ids = Array.from(new Set(kept.map(r => r.actor_id).filter(Boolean)))
  const names = new Map<string, string>()
  // Auth holds them (as lp-onboarding-notify.ts reads them); a trail touches few people.
  await Promise.all(ids.map(async id => {
    try {
      const { data } = await admin.auth.admin.getUserById(id)
      const u = data?.user
      if (u) names.set(id, (u.user_metadata?.full_name as string | undefined) || u.email || id)
    } catch { /* an id with no user stays an id */ }
  }))
  return kept.map(r => ({
    id: r.id, createdAt: r.created_at, action: r.action, subjectType: r.subject_type, subjectId: r.subject_id ?? null,
    vehicleId: r.vehicle_id ?? null, actorId: r.actor_id ?? null, actorName: r.actor_id ? names.get(r.actor_id) ?? null : null,
    reason: r.reason ?? null, details: r.details ?? {},
    // The column, or `details.source` when it was written before the column existed (events.ts).
    source: r.source ?? (typeof r.details?.source === 'string' ? r.details.source : null),
  }))
}

// Through the shared writer: an action, reason or name starting with = + - @ is text in Excel, not a formula.
const csvCell = (v: unknown) => csvField(v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v))

export function auditCsv(rows: AuditRow[], vehicleNames: Map<string, string>): string {
  const header = ['When (UTC)', 'Entity', 'Who', 'Source', 'Action', 'Subject', 'Subject id', 'Reason', 'Details']
  const lines = rows.map(r => [
    r.createdAt, r.vehicleId ? vehicleNames.get(r.vehicleId) ?? r.vehicleId : '', r.actorName ?? r.actorId ?? '',
    r.source ?? '', r.action, r.subjectType, r.subjectId ?? '', r.reason ?? '', r.details,
  ].map(csvCell).join(','))
  return [header.join(','), ...lines].join('\n')
}
