// Handlers for the OPERATIONS tools (operations-tools-manifest.ts). Each reads through the same
// library the web page beside it uses, so an answer in chat and the page agree.
//
// ACCESS. The dispatcher has cleared each tool's own domain before its handler runs, and for the
// two entity tools it has resolved an entity the caller may see. What is left is done here: every
// fund-wide read is cut to the caller's entities, and `whats_due`, whose list straddles four
// domains, keeps only the sources the caller holds.

import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { hasAccess } from '@/lib/access/effective'
import { canSeeVehicle, visibleCompanyIds } from '@/lib/access/scope'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { loadLpScope, lpVisible, visibleLpItems } from '@/lib/access/lp-scope'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { approveCloses } from '@/lib/accounting/close-approval'
import { loadCloseStatus } from '@/lib/accounting/close-status'
import { complianceCalendar, loadComplianceData } from '@/lib/compliance/calendar'
import { loadQuarterRequestStatus } from '@/lib/requests/quarter-status'
import { listRecentDeliveries, type DeliveryKind } from '@/lib/lp-deliveries'
import { collectReminders } from '@/lib/reminders/collect'
import { loadFundReminderData, loadReminderSettings } from '@/lib/reminders/load'
import type { ReminderSource } from '@/lib/reminders/types'
import { PROFILE_COLUMNS, parseProfilePatch, profileFromRow } from '@/lib/vehicle-profile'

const ISO = /^\d{4}-\d{2}-\d{2}$/

function isoArg(input: any, key: string): string | undefined {
  const v = input?.[key]
  if (v == null || v === '') return undefined
  const s = String(v)
  const d = ISO.test(s) ? new Date(`${s}T00:00:00Z`) : null
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error(`${key} must be a real date (YYYY-MM-DD)`)
  return s
}

const todayIso = () => new Date().toISOString().slice(0, 10)

const MISSING_COLUMNS = /column|schema cache/i
const NOT_MIGRATED = 'Entity profiles are not available yet: the database migration that adds them has not been applied.'

async function entityId(ctx: AgentToolContext): Promise<string> {
  const id = await vehicleIdByName(ctx.admin, ctx.fundId, ctx.portfolioGroup)
  if (!id) throw new Error(`Unknown entity "${ctx.portfolioGroup}"`)
  return id
}

/** Which access a reminder source needs, beyond the tool's own `compliance` read. */
const SOURCE_ACCESS: Record<ReminderSource, (ctx: AgentToolContext) => boolean> = {
  compliance: ctx => hasAccess(ctx.access, 'compliance', 'read'),
  asks_send: ctx => hasAccess(ctx.access, 'portfolio', 'read', 'asks'),
  asks_followup: ctx => hasAccess(ctx.access, 'portfolio', 'read', 'asks'),
  calls_due: ctx => hasAccess(ctx.access, 'lp_capital', 'read'),
  onboarding: ctx => hasAccess(ctx.access, 'lp_relations', 'read', 'lp_portal'),
}

export const OPERATIONS_HANDLERS: Record<string, AgentToolHandler> = {
  entity_profile: async ctx => {
    const id = await entityId(ctx)
    const { data, error } = await (ctx.admin as any).from('fund_vehicles').select(PROFILE_COLUMNS).eq('fund_id', ctx.fundId).eq('id', id).maybeSingle()
    if (error) throw new Error(MISSING_COLUMNS.test(error.message ?? '') ? NOT_MIGRATED : error.message)
    return { vehicle: ctx.portfolioGroup, ...profileFromRow(data) }
  },

  set_entity_profile: async (ctx, input) => {
    const { vehicle: _vehicle, ...fields } = (input ?? {}) as Record<string, unknown>
    const parsed = parseProfilePatch(fields)
    if ('error' in parsed) throw new Error(parsed.error)
    if (Object.keys(parsed.update).length === 0) throw new Error('Nothing to change: send at least one profile field.')
    const id = await entityId(ctx)
    const { data, error } = await (ctx.admin as any).from('fund_vehicles').update(parsed.update)
      .eq('fund_id', ctx.fundId).eq('id', id).select(PROFILE_COLUMNS).maybeSingle()
    if (error) throw new Error(MISSING_COLUMNS.test(error.message ?? '') ? NOT_MIGRATED : error.message)
    return { vehicle: ctx.portfolioGroup, ...profileFromRow(data) }
  },

  approve_close: async (ctx, input) => {
    if (!ctx.userId) throw new Error('Approving a close needs a person: this credential has no member behind it.')
    const through = isoArg(input, 'through')
    if (!through) throw new Error('through (the date to approve through) is required')
    const attestation = typeof input?.attestation === 'string' ? input.attestation : null
    const result = await approveCloses(ctx.admin, ctx.fundId, ctx.portfolioGroup, ctx.userId, { through }, attestation)
    if ('error' in result) throw new Error(result.error)
    return { vehicle: ctx.portfolioGroup, ...result }
  },

  close_status: async (ctx, input) => {
    const result = await loadCloseStatus(ctx.admin, ctx.fundId, {
      includeManco: hasAccess(ctx.access, 'management_company', 'read'),
      visible: id => canSeeVehicle(ctx.access, id),
      quarterEnd: isoArg(input, 'quarter_end'),
      vehicle: typeof input?.vehicle === 'string' ? input.vehicle : undefined,
    })
    if ('error' in result) throw new Error(result.error)
    return result
  },

  data_request_status: async (ctx, input) => {
    const hasYear = input?.year != null
    const hasQuarter = input?.quarter != null
    if (hasYear !== hasQuarter) throw new Error('Send year and quarter together, or neither for the last quarter that has ended.')
    let period: { year: number; quarter: number } | null = null
    if (hasYear) {
      const year = Number(input.year)
      const quarter = Number(input.quarter)
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('year must be a four-digit year')
      if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) throw new Error('quarter must be 1 to 4')
      period = { year, quarter }
    }
    const companies = await visibleCompanyIds(ctx.admin, ctx.access)
    return loadQuarterRequestStatus(ctx.admin, ctx.fundId, companies, period, todayIso())
  },

  compliance_calendar: async (ctx, input) => {
    const today = todayIso()
    const year = input?.year != null ? Number(input.year) : Number(today.slice(0, 4))
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('year must be a four-digit year')
    const from = isoArg(input, 'from')
    const to = isoArg(input, 'to')
    const data = await loadComplianceData(ctx.admin, ctx.fundId, year, year)
    // The compliance page's rule: firm-level filings for everyone who reads compliance, an
    // entity's own filings only where the caller may see that entity.
    const { vehicleNames } = await entityScopeFor(ctx.admin, ctx.access)
    const wanted = typeof input?.vehicle === 'string' && input.vehicle.trim() ? input.vehicle.trim().toLowerCase() : null
    const rows = complianceCalendar(data, year, today).filter(r =>
      (!r.entity || vehicleNames === null || vehicleNames.includes(r.entity))
      && (!wanted || r.entity.toLowerCase() === wanted)
      && (!from || r.dueDate >= from) && (!to || r.dueDate <= to))
    const counts = { open: 0, overdue: 0, filed: 0, not_applicable: 0 }
    for (const r of rows) counts[r.state] += 1
    return { year, counts, filings: rows }
  },

  lp_delivery_log: async (ctx, input) => {
    const since = isoArg(input, 'since') ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
    const limit = Math.min(Math.max(1, Math.floor(Number(input?.limit ?? 100)) || 100), 500)
    const kind = typeof input?.kind === 'string' && input.kind ? (input.kind as DeliveryKind) : undefined
    const lp = await loadLpScope(ctx.admin, { fundId: ctx.fundId, userId: ctx.access.userId, role: ctx.access.role })
    const page = await listRecentDeliveries(ctx.admin, ctx.fundId, { since, kind, limit })
    let rows = page.filter(d => lpVisible(lp.investorIds, d.lpInvestorId))
    // A document or letter delivery only where the caller can see that item, as /api/lps/deliveries.
    const docs = rows.filter(d => d.kind === 'document' && d.itemId).map(d => d.itemId!)
    const letters = rows.filter(d => d.kind === 'letter' && d.itemId).map(d => d.itemId!)
    const items = await visibleLpItems(ctx.admin, ctx.fundId, lp, { documents: docs, letters })
    if (items) {
      rows = rows.filter(d =>
        d.kind === 'document' ? !!d.itemId && items.documents.has(d.itemId)
          : d.kind === 'letter' ? !!d.itemId && items.letters.has(d.itemId)
            : true)
    }
    const investorIds = Array.from(new Set(rows.map(d => d.lpInvestorId).filter(Boolean))) as string[]
    const names = new Map<string, string>()
    if (investorIds.length) {
      const { data } = await (ctx.admin as any).from('lp_investors').select('id, name').eq('fund_id', ctx.fundId).in('id', investorIds)
      for (const r of (data as any[]) ?? []) names.set(r.id, r.name)
    }
    return {
      since,
      deliveries: rows.map(d => ({
        kind: d.kind, investor: d.lpInvestorId ? names.get(d.lpInvestorId) ?? null : null, to: d.toEmail,
        subject: d.subject, status: d.status, error: d.error, sentAt: d.sentAt,
      })),
      // The newest `limit` sends, before scoping: a full page means older ones may exist.
      hasMore: page.length === limit,
    }
  },

  whats_due: async ctx => {
    // The digest is built fund-wide and its lines do not all name an entity, so it cannot be cut
    // to some of them. A member limited to certain entities gets the per-area tools instead.
    if (!ctx.access.vehicles.all) {
      throw new Error('whats_due covers every entity, and you have access to some of them only. Use close_status, compliance_calendar and data_request_status, which are cut to your entities.')
    }
    const today = todayIso()
    const settings = await loadReminderSettings(ctx.admin, ctx.fundId)
    const data = await loadFundReminderData(ctx.admin, ctx.fundId, today, settings.asksSendOffsetDays)
    const items = collectReminders(data, today).filter(i => SOURCE_ACCESS[i.source](ctx))
    return {
      today,
      items: items.map(i => ({ source: i.source, title: i.title, detail: i.detail ?? null, dueDate: i.dueDate, state: i.state, link: i.href })),
    }
  },
}
