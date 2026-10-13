// What publishing an ISSUED capital call's notices would do, before anything goes out.
//
// Publishing files one notice per partner in their LP portal, and a partner reads it as a demand
// for money. So a chat may ask for it, but only after this review has been shown, and a person
// approves it in the app (lib/pending-actions/call-notices.ts). The review lists each partner's
// figure from the frozen register line, who would see it, and what is missing or wrong, in the same
// missing-and-flags shape as a proposed call (lib/drafting/checks.ts).
//
// The preview token is a fingerprint of everything the notices would say. Staging carries it, and
// publishing refuses when the call has changed since: what the approver read is what goes out.
//
// Reads only. Nothing here renders a PDF (lib/pdf-routes.mjs).

import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { earliestDue } from './capital-call-check'
import { loadCallFacts } from './proposed-calls'
import { loadNoticeRegister, previewNoticeRecipients, type NoticeLine } from './notice-register'
import { roundCents } from './ledger'
import type { DraftFlag, MissingItem } from '@/lib/drafting/checks'
import { done, fail, type Outcome } from '@/lib/service-outcome'

export interface CallNoticePartner {
  lpEntityId: string
  name: string
  amount: number
  /** This line over the call's LP total, 0..1. */
  share: number
  /** The partner's portal already holds this notice; publishing again reuses it. */
  alreadyPublished: boolean
  /** Who can open it in the portal, or why nobody can yet. */
  portalAccount: string | null
  notShared: string | null
}

export interface CallNoticeReview {
  vehicle: string
  call: {
    id: string
    number: number | null
    noticeDate: string
    dueDate: string | null
    description: string | null
    total: number
    purposes: { label: string; amount: number; basis?: string | null }[]
  }
  partners: CallNoticePartner[]
  /** Partners who would get a NEW notice (the rest already have it). */
  newNotices: number
  portalEnabled: boolean
  earliestDueDate: string | null
  missing: MissingItem[]
  flags: DraftFlag[]
  previewToken: string
}

/** Everything a notice states, hashed. Any change to a figure, date, purpose or the wire text changes it. */
export function callNoticeFingerprint(parts: {
  callId: string
  noticeDate: string
  dueDate: string | null
  description: string | null
  purposes: unknown
  wireInstructions: string | null
  lines: Pick<NoticeLine, 'id' | 'lpEntityId' | 'amount' | 'noticeDocumentId'>[]
}): string {
  const lines = [...parts.lines]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(l => [l.id, l.lpEntityId, roundCents(l.amount), l.noticeDocumentId ?? null])
  const canonical = JSON.stringify([parts.callId, parts.noticeDate, parts.dueDate, parts.description, parts.purposes ?? null, parts.wireInstructions, lines])
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

export async function reviewCallNotices(
  admin: SupabaseClient,
  ctx: { fundId: string; group: string },
  callId: string,
  opts: { lpEntityIds?: string[] | null; today?: string } = {},
): Promise<Outcome<CallNoticeReview>> {
  const reg = await loadNoticeRegister(admin, ctx.fundId, ctx.group, 'capital_call', callId)
  if ('error' in reg) return fail(reg.status, reg.error)

  const requested = (opts.lpEntityIds ?? []).filter(Boolean)
  const unknown = requested.filter(id => !reg.lines.some(l => l.lpEntityId === id))
  if (unknown.length) return fail(400, `Not partners on this call: ${unknown.join(', ')}.`)
  const targets = requested.length ? reg.lines.filter(l => requested.includes(l.lpEntityId)) : reg.lines

  const [facts, recipients] = await Promise.all([
    loadCallFacts(admin, ctx.fundId, ctx.group, opts.today),
    previewNoticeRecipients(admin, ctx.fundId, ctx.group, reg, targets.map(t => t.lpEntityId)),
  ])
  const byEntity = new Map(recipients.recipients.map(r => [r.lpEntityId, r]))
  const lpTotal = roundCents(reg.lines.filter(l => l.role === 'lp').reduce((s, l) => s + l.amount, 0))

  const partners: CallNoticePartner[] = targets.map(l => {
    const r = byEntity.get(l.lpEntityId)
    return {
      lpEntityId: l.lpEntityId,
      name: r?.name ?? l.lpEntityId,
      amount: l.amount,
      share: lpTotal > 0 ? l.amount / lpTotal : 0,
      alreadyPublished: !!l.noticeDocumentId,
      portalAccount: r?.to ?? null,
      notShared: r?.skipped ?? null,
    }
  })

  const missing: MissingItem[] = []
  const flags: DraftFlag[] = []
  const purposes = reg.purposes ?? []

  if (!facts.wireInstructions) {
    missing.push({
      field: 'wire_instructions', label: 'Wire instructions', required: false,
      why: `None are recorded for ${ctx.group}, so the notice will not say where to send the money. Add them under the vehicle's payment instructions first.`,
    })
  }
  if (!reg.dueDate) {
    missing.push({ field: 'due_date', label: 'Due date', required: false, why: 'The call was issued without one, so the notice will not say when the money is due.' })
  }
  if (purposes.length === 0) {
    missing.push({ field: 'purposes', label: 'Purpose of the call, with amounts', required: false, why: 'The call was issued without them, so the notice shows the description only.' })
  }

  let earliestDueDate: string | null = null
  const days = facts.storedNoticeDays
  if (days == null) {
    missing.push({
      field: 'notice_period_days', label: 'Notice period required by the LPA', required: false,
      why: `No notice period is recorded for ${ctx.group}, so the due date was not checked against it.`,
    })
  } else {
    const basis = facts.storedNoticeBasis ?? 'calendar'
    earliestDueDate = earliestDue(reg.noticeDate, days, basis)
    if (reg.dueDate && reg.dueDate < earliestDueDate) {
      flags.push({
        code: 'due_inside_notice_period', severity: 'warning', date: reg.dueDate,
        message: `The due date ${reg.dueDate} falls inside the ${days}-${basis === 'business' ? 'business-day' : 'day'} notice period from ${reg.noticeDate}. The earliest due date the LPA allows is ${earliestDueDate}, unless the LPs waive it.`,
      })
    }
  }
  const today = facts.today
  if (reg.noticeDate < today) {
    flags.push({
      code: 'notice_date_past', severity: 'warning', date: reg.noticeDate,
      message: `The notice is dated ${reg.noticeDate}, the call date, which is before today. Partners will receive it later than it says.`,
    })
  }
  if (!recipients.portalEnabled) {
    flags.push({ code: 'portal_off', severity: 'warning', message: 'The LP portal is off, so no partner can open a published notice until it is turned on.' })
  }
  for (const p of partners.filter(p => p.notShared)) {
    flags.push({ code: 'not_shared', severity: 'warning', subject: p.lpEntityId, message: `${p.name}: ${p.notShared}. The notice will be filed but nobody can open it yet.` })
  }
  const newNotices = partners.filter(p => !p.alreadyPublished).length
  if (newNotices === 0) {
    flags.push({ code: 'nothing_to_publish', severity: 'blocker', message: 'Every selected partner already has this notice in their portal.' })
  }

  return done({
    vehicle: ctx.group,
    call: {
      id: reg.id,
      number: reg.numberLabel,
      noticeDate: reg.noticeDate,
      dueDate: reg.dueDate,
      description: reg.description,
      total: lpTotal,
      purposes,
    },
    partners,
    newNotices,
    portalEnabled: recipients.portalEnabled,
    earliestDueDate,
    missing,
    flags,
    previewToken: callNoticeFingerprint({
      callId: reg.id, noticeDate: reg.noticeDate, dueDate: reg.dueDate, description: reg.description,
      purposes, wireInstructions: facts.wireInstructions, lines: targets,
    }),
  })
}

/** One plain line for an approver or a chat: what would go out. */
export function describeCallNotices(r: CallNoticeReview): string {
  const call = `capital call${r.call.number ? ` No. ${r.call.number}` : ''} of ${r.call.noticeDate}`
  const due = r.call.dueDate ? `, due ${r.call.dueDate}` : ''
  const reused = r.partners.length - r.newNotices
  return `Publish ${r.newNotices} notice${r.newNotices === 1 ? '' : 's'} for ${call} on ${r.vehicle}${due} to the partners' LP portals` +
    (reused ? ` (${reused} already published, reused)` : '') + '.'
}
