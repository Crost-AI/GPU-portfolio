// The capital call notice tools (call-notice-tools-manifest.ts). Each calls the service the
// call-notices route calls (lib/accounting/call-notice-drafts.ts) on the vehicle the dispatcher
// resolved with the caller's access, so a member sees and drafts only on their own entities.

import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import {
  approveCallNoticeDraft, createCallNoticeDraft, discardCallNoticeDraft, getCallNoticeDraft, listCallNoticeDrafts,
  reviseCallNoticeDraft, type DraftStatus, type DraftView,
} from '@/lib/accounting/call-notice-drafts'
import { callNoticeRequestFrom } from '@/lib/accounting/call-notice-input'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { unwrap, type Outcome } from '@/lib/service-outcome'
import { reportLinkUrl, signReportLink } from '@/lib/agent/report-links'
import { siteOrigin } from '@/lib/site-links'
import { requireUser } from './deals-tools'

const ctxOf = (c: AgentToolContext) => ({ fundId: c.fundId, group: c.portfolioGroup, userId: c.userId })

/** A draft as the assistant reads it: figures first, then what to tell the user. */
function present(d: DraftView) {
  return {
    draft_id: d.id,
    status: d.status,
    vehicle: d.vehicle,
    total: d.total,
    description: d.description,
    purposes: d.purposes,
    notice_date: d.noticeDate,
    due_date: d.dueDate,
    notice_period: d.noticePeriod,
    earliest_due_date: d.earliestDueDate,
    total_commitments: d.totalCommitments,
    lines: d.lines.map(l => ({
      lp_entity_id: l.lpEntityId, lp: l.name, commitment: l.commitment,
      share_pct: Math.round(l.share * 1e6) / 1e4, amount: l.amount,
      called_before: l.calledToDate, remaining_after: l.remainingAfter,
    })),
    missing: d.missing,
    flags: d.flags,
    approvable: d.approvable,
    needs_acknowledgement: d.needsAcknowledgement,
    capital_call_id: d.capitalCallId,
    next: d.status !== 'draft'
      ? `This draft is ${d.status}.`
      : !d.approvable
        ? 'List every missing item and blocker for the user. It cannot be approved until they are resolved (revise_capital_call_notice).'
        : 'Show the per-LP table, then every missing item and flag. An admin approves it with approve_capital_call_notice, or on the Capital page.',
  }
}

/** The refusal with its reasons, so the assistant can say what is in the way. */
function orThrow<T>(o: Outcome<T>): T {
  if (o.ok) return o.value
  const extra = o.extra ? ` ${JSON.stringify(o.extra)}` : ''
  throw new Error(`${o.error}${extra}`)
}

export const CALL_NOTICE_HANDLERS: Record<string, AgentToolHandler> = {
  draft_capital_call_notice: async (ctx, input) => {
    requireUser(ctx.userId)
    const parsed = callNoticeRequestFrom(input)
    if ('error' in parsed) throw new Error(parsed.error)
    return present(unwrap(await createCallNoticeDraft(ctx.admin, ctxOf(ctx), parsed.request)))
  },

  revise_capital_call_notice: async (ctx, input) => {
    requireUser(ctx.userId)
    const parsed = callNoticeRequestFrom(input, { partial: true })
    if ('error' in parsed) throw new Error(parsed.error)
    return present(unwrap(await reviseCallNoticeDraft(ctx.admin, ctxOf(ctx), String(input?.draft_id ?? ''), parsed.request)))
  },

  capital_call_notice_drafts: async (ctx, input) => {
    const vehicleId = await vehicleIdByName(ctx.admin, ctx.fundId, ctx.portfolioGroup)
    if (!vehicleId) return { drafts: [] }
    const status = ['draft', 'approved', 'discarded'].includes(input?.status) ? input.status as DraftStatus : undefined
    const drafts = unwrap(await listCallNoticeDrafts(ctx.admin, ctx.fundId, [{ id: vehicleId, name: ctx.portfolioGroup }], status))
    return { drafts: drafts.map(d => ({ draft_id: d.id, status: d.status, vehicle: d.vehicle, total: d.total, notice_date: d.noticeDate, due_date: d.dueDate, description: d.description, capital_call_id: d.capitalCallId, created_at: d.createdAt })) }
  },

  capital_call_notice_draft: async (ctx, input) =>
    present(unwrap(await getCallNoticeDraft(ctx.admin, ctxOf(ctx), String(input?.draft_id ?? '')))),

  capital_call_notice_pdf: async (ctx, input) => {
    const userId = requireUser(ctx.userId)
    const d = unwrap(await getCallNoticeDraft(ctx.admin, ctxOf(ctx), String(input?.draft_id ?? '')))
    const want = String(input?.lp ?? '').trim().toLowerCase()
    const matches = d.lines.filter(l => l.lpEntityId === input?.lp || l.name.toLowerCase() === want)
    const loose = matches.length ? matches : d.lines.filter(l => want && l.name.toLowerCase().includes(want))
    if (loose.length !== 1) {
      throw new Error(loose.length === 0
        ? `No LP on this draft matches "${input?.lp}". The draft's LPs: ${d.lines.map(l => l.name).join(', ')}.`
        : `"${input?.lp}" matches several LPs: ${loose.map(l => l.name).join(', ')}. Ask which.`)
    }
    const line = loose[0]
    const { token, expiresAt } = signReportLink({
      fundId: ctx.fundId, userId, kind: 'call_notice_draft',
      args: { vehicle: ctx.portfolioGroup, draft: d.id, lp: line.lpEntityId },
    })
    return { document: `DRAFT capital call notice for ${line.name} (PDF)`, url: reportLinkUrl(ctx.origin ?? siteOrigin(), token), expires_at: expiresAt }
  },

  discard_capital_call_notice: async (ctx, input) => {
    requireUser(ctx.userId)
    return unwrap(await discardCallNoticeDraft(ctx.admin, ctxOf(ctx), String(input?.draft_id ?? '')))
  },

  approve_capital_call_notice: async (ctx, input) => {
    requireUser(ctx.userId)
    const out = orThrow(await approveCallNoticeDraft(ctx.admin, ctxOf(ctx), String(input?.draft_id ?? ''), {
      role: ctx.access.role, acknowledge: input?.acknowledge === true,
    }))
    return {
      draft_id: out.id,
      capital_call_id: out.capitalCallId,
      issued: out.issued,
      advances_applied: out.advancesApplied,
      next:
        'The call is issued to the books. Its notices are not in the LPs\' portals yet: an admin publishes them, and can ' +
        'email them, from the call on the Capital accounts page. Approving a draft on the vehicle\'s Admin page does both at once.',
    }
  },

  set_call_notice_period: async (ctx, input) => {
    requireUser(ctx.userId)
    const days = Number(input?.days)
    if (!Number.isInteger(days) || days < 0 || days > 365) throw new Error('days must be a whole number from 0 to 365')
    const basis = input?.basis === 'business' ? 'business' : 'calendar'
    const vehicleId = await vehicleIdByName(ctx.admin, ctx.fundId, ctx.portfolioGroup)
    if (!vehicleId) throw new Error(`"${ctx.portfolioGroup}" is not in this fund's vehicle registry.`)
    const { error } = await (ctx.admin as any).from('vehicle_accounting_settings').upsert(
      { fund_id: ctx.fundId, vehicle_id: vehicleId, call_notice_days: days, call_notice_basis: basis, updated_at: new Date().toISOString() },
      { onConflict: 'fund_id,vehicle_id' },
    )
    // The dispatcher records the write in the audit trail (lib/agent/dispatch.ts).
    if (error) throw new Error('The notice period could not be saved.')
    return { vehicle: ctx.portfolioGroup, call_notice_days: days, call_notice_basis: basis }
  },
}
