// A notice's figures, from the register row to the data each partner's PDF is rendered from, and
// who it would go to. Everything here reads; nothing renders or sends. Kept apart from notices.ts
// (which renders, files and emails) so a preview of what WOULD be published (the Approvals card,
// a chat's preview_call_notices) needs no headless Chromium (lib/pdf-routes.mjs).
//
// Every figure comes from the REGISTER, never recomputed: the 1300 receivable and the 2300 payable
// both decay as money moves, so deriving a notice from the ledger would restate what a partner was
// told every time somebody paid.

import type { SupabaseClient } from '@supabase/supabase-js'
import { callExtras, distributionDeductions } from './call-extras'
import type { NoticeData, NoticeKind } from './notice-types'
import { lpCapitalSummary, listCapitalCalls } from './capital-calls'
import { loadEntityNames } from './load'
import { vehicleIdByName } from './vehicle-id'
import { displayFontOf } from '@/lib/theme'
import { ACTUAL_BOOK } from './books'
import { resolveLpRecipients } from '@/lib/lp-recipients'
import { getOutboundConfig } from '@/lib/email'
import { buildLpEmailHtml, siteUrl } from '@/lib/lp-email'
import { roundCents } from './ledger'
import { documentLetterhead } from '@/lib/vehicle-letterhead'
import { PURPOSE_LABEL, type PurposeCategory } from './capital-call-check'

export interface NoticeLine {
  id: string
  lpEntityId: string
  amount: number
  role: 'lp' | 'carry'
  noticeDocumentId: string | null
}

export interface NoticeRegister {
  kind: NoticeKind
  id: string
  noticeDate: string
  description: string | null
  numberLabel: number | null
  dueDate: string | null
  lines: NoticeLine[]
  /** The waterfall tiers, for a distribution declared through one. */
  tiers: { returnOfCapital: number; preferred: number; lpTotal: number } | null
  /** Set when the register has a posted entry behind it (ledger vehicles). */
  posted: boolean
  /** True on a capital-tracking vehicle, where there is no entry to check. */
  tracking: boolean
  /** Calls drafted as a notice (lib/accounting/proposed-calls.ts): what the call is for. */
  purposes?: { label: string; amount: number; basis?: string | null }[] | null
}

/** The register row a notice is rendered from, or why there is none to render. */
export async function loadNoticeRegister(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  kind: NoticeKind,
  id: string,
): Promise<NoticeRegister | { error: string; status: number }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)

  let row: any
  let entryIds: string[] = []
  if (kind === 'capital_call') {
    const { data } = await admin
      .from('capital_calls' as any)
      .select('id, call_date, call_number, description, due_date, status, journal_entry_id, capital_call_lines(id, lp_entity_id, amount, notice_document_id)')
      .eq('id', id).eq('fund_id', fundId).eq('vehicle_id', vehicleId)
      .maybeSingle()
    if (!data) return { error: 'Capital call not found on this vehicle', status: 404 }
    row = data
    entryIds = [row.journal_entry_id].filter(Boolean)
  } else {
    const { data } = await admin
      .from('distributions' as any)
      .select('id, distribution_date, distribution_number, description, status, journal_entry_id, carry_journal_entry_id, wf_return_of_capital, wf_preferred, distribution_lines(id, lp_entity_id, amount, role, notice_document_id)')
      .eq('id', id).eq('fund_id', fundId).eq('vehicle_id', vehicleId)
      .maybeSingle()
    if (!data) return { error: 'Distribution not found on this vehicle', status: 404 }
    row = data
    entryIds = [row.journal_entry_id, row.carry_journal_entry_id].filter(Boolean)
  }

  const rawLines: any[] = kind === 'capital_call' ? (row.capital_call_lines ?? []) : (row.distribution_lines ?? [])
  const lines: NoticeLine[] = rawLines.map(l => ({
    id: l.id,
    lpEntityId: l.lp_entity_id,
    amount: Number(l.amount),
    role: l.role === 'carry' ? 'carry' : 'lp',
    noticeDocumentId: l.notice_document_id ?? null,
  }))
  if (lines.length === 0) return { error: 'That has no partner lines to notice', status: 400 }

  // REFUSE TO NOTICE SOMETHING NOT IN THE BOOKS.
  //
  // A notice is a demand for money, or a promise of it. Sending one for a draft — or for an
  // entry that was voided after the fact — tells a partner to wire against something the fund
  // has no record of owing or being owed. A tracking vehicle keeps no entry; there the register
  // row is the record, and 'issued' / 'declared' is the check.
  let posted = false
  if (entryIds.length === 0) {
    posted = row.status === 'issued' || row.status === 'declared'
    if (!posted) return { error: `That is still a ${row.status}; issue it before sending notices.`, status: 400 }
  } else {
    if (entryIds.length === 0) {
      return { error: 'That has no journal entry — it was never posted, so there is nothing to notice.', status: 400 }
    }
    const { data: entries } = await admin
      .from('journal_entries' as any).select('id, status').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('id', entryIds)
    const statuses = ((entries as any[]) ?? []).map(e => e.status)
    posted = statuses.length === entryIds.length && statuses.every(s => s === 'posted')
    if (!posted) {
      const bad = statuses.find(s => s !== 'posted') ?? 'missing'
      return { error: `Its journal entry is ${bad}, not posted. Post it before sending notices — otherwise the notice states an amount the books don't carry.`, status: 400 }
    }
  }

  const lpTotal = roundCents(lines.filter(l => l.role === 'lp').reduce((s, l) => s + l.amount, 0))
  const purposes = kind === 'capital_call' ? await loadCallPurposes(admin, fundId, id) : null
  return {
    purposes,
    kind,
    id,
    noticeDate: kind === 'capital_call' ? row.call_date : row.distribution_date,
    description: row.description ?? null,
    numberLabel: (kind === 'capital_call' ? row.call_number : row.distribution_number) ?? null,
    dueDate: kind === 'capital_call' ? (row.due_date ?? null) : null,
    lines,
    tiers: kind === 'distribution' && row.wf_return_of_capital != null
      ? { returnOfCapital: Number(row.wf_return_of_capital), preferred: Number(row.wf_preferred ?? 0), lpTotal }
      : null,
    posted,
    tracking: entryIds.length === 0,
  }
}

/**
 * The purposes frozen on a call issued from a notice draft. Read on its own, and an error read as
 * none, so a release that is live before the column is pushed still publishes notices.
 */
async function loadCallPurposes(admin: SupabaseClient, fundId: string, callId: string): Promise<NoticeRegister['purposes']> {
  const { data, error } = await (admin as any).from('capital_calls').select('purposes').eq('id', callId).eq('fund_id', fundId).maybeSingle()
  if (error || !Array.isArray((data as any)?.purposes)) return null
  return purposeRows((data as any).purposes)
}

/** Stored purposes as the notice prints them. */
export function purposeRows(raw: unknown[]): { label: string; amount: number; basis?: string | null }[] {
  return raw
    .filter((p: any) => p && Number.isFinite(Number(p.amount)))
    .map((p: any) => ({ label: String(p.description || PURPOSE_LABEL[p.category as PurposeCategory] || 'Other'), amount: Number(p.amount), basis: p.basis ?? null }))
}

export function noticeTitle(reg: Pick<NoticeRegister, 'kind' | 'numberLabel' | 'noticeDate'>): string {
  return reg.kind === 'capital_call'
    ? `Capital Call Notice${reg.numberLabel ? ` No. ${reg.numberLabel}` : ''} — ${reg.noticeDate}`
    : `Distribution Notice${reg.numberLabel ? ` No. ${reg.numberLabel}` : ''} — ${reg.noticeDate}`
}

export interface PublishContext {
  fundId: string
  group: string
  userId: string
}

/** One partner's notice as it would be rendered: the data, and who it is for. */
export interface NoticeForLine {
  line: NoticeLine
  partnerName: string
  investorId: string | null
  data: NoticeData
}

/**
 * The data each selected partner's notice is rendered from, exactly as publishing renders it. The
 * AMOUNT is the frozen register line; the context (commitment, called to date, charges, advances)
 * is the partner's standing position, which legitimately moves.
 */
export async function noticeDataFor(
  admin: SupabaseClient,
  ctx: Pick<PublishContext, 'fundId' | 'group'>,
  reg: NoticeRegister,
  targets: NoticeLine[],
): Promise<NoticeForLine[]> {
  const { fundId, group } = ctx
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const [fundRes, settingsRes, vehSettingsRes, names, summary, entityRows] = await Promise.all([
    admin.from('funds' as any).select('name, logo_url, address').eq('id', fundId).maybeSingle(),
    admin.from('fund_settings' as any).select('currency, theme').eq('fund_id', fundId).maybeSingle(),
    admin.from('vehicle_accounting_settings' as any).select('wire_instructions').eq('vehicle_id', vehicleId).maybeSingle(),
    loadEntityNames(admin, fundId, group),
    lpCapitalSummary(admin, fundId, group),
    admin.from('lp_entities' as any).select('id, investor_id').eq('fund_id', fundId).in('id', targets.map(t => t.lpEntityId)),
  ])
  const fund = (fundRes as any).data
  // The vehicle's own letterhead where it has one, else the fund's (lib/vehicle-letterhead.ts).
  // Logos are data URIs only: a remote URL silently fails to render inside headless Chrome.
  const letterhead = await documentLetterhead(admin, fundId, fund, [group])
  const currency = (settingsRes as any).data?.currency || 'USD'
  const wireInstructions = (vehSettingsRes as any).data?.wire_instructions ?? null
  const summaryByLp = new Map(summary.map(r => [r.lpEntityId, r]))
  // What else is on each partner's notice (lib/accounting/call-extras.ts): on a call, the charges
  // collected with it, the advance applied to it, and what earlier calls still have outstanding;
  // on a distribution, the deductions taken from it.
  const extras = reg.kind === 'capital_call' ? (await callExtras(admin, fundId, vehicleId, [reg.id])).get(reg.id) : undefined
  const deductions = reg.kind === 'distribution' ? (await distributionDeductions(admin, fundId, vehicleId, [reg.id])).get(reg.id) : undefined
  const earlierUnpaid = new Map<string, number>()
  if (reg.kind === 'capital_call') {
    for (const c of await listCapitalCalls(admin, fundId, group)) {
      if (c.id === reg.id || c.callDate > reg.noticeDate) continue
      for (const l of c.lines) earlierUnpaid.set(l.lpEntityId, roundCents((earlierUnpaid.get(l.lpEntityId) ?? 0) + l.outstanding))
    }
  }
  const investorByEntity = new Map<string, string | null>(
    (((entityRows as any).data as any[]) ?? []).map(e => [e.id as string, (e.investor_id ?? null) as string | null])
  )
  // A call with purposes is fund-wide and split by commitment, so a line over the call is the
  // partner's share of commitments.
  const callTotal = roundCents(reg.lines.filter(l => l.role === 'lp').reduce((s, l) => s + l.amount, 0))

  return targets.map(line => {
    const partnerName = names.get(line.lpEntityId) ?? line.lpEntityId
    const row = summaryByLp.get(line.lpEntityId)
    const context: { label: string; value: number | null }[] = []
    if (reg.kind === 'capital_call') {
      const charges = extras?.charges.get(line.lpEntityId) ?? []
      const applied = extras?.advance.get(line.lpEntityId) ?? 0
      const earlier = earlierUnpaid.get(line.lpEntityId) ?? 0
      for (const c of charges) context.push({ label: `Plus: ${c.description}`, value: c.amount })
      if (applied > 0.004) context.push({ label: 'Less: received from you in advance', value: -applied })
      if (earlier > 0.004) context.push({ label: 'Plus: unpaid from earlier calls', value: earlier })
      if (charges.length || applied > 0.004 || earlier > 0.004) {
        context.push({ label: 'Total due', value: roundCents(line.amount + charges.reduce((s, c) => s + c.amount, 0) - applied + earlier) })
      }
      if (row) {
        context.push(
          { label: 'Commitment', value: row.commitment },
          { label: 'Called to date', value: row.called },
          { label: 'Remaining to be called', value: row.outstanding },
        )
      }
    } else if (reg.kind === 'distribution') {
      const taken = deductions?.get(line.lpEntityId) ?? []
      for (const d of taken) context.push({ label: `Less: ${d.description}`, value: -d.amount })
      if (taken.length) context.push({ label: 'Net paid to you', value: roundCents(line.amount - taken.reduce((s, d) => s + d.amount, 0)) })
      if (line.role === 'lp' && reg.tiers && reg.tiers.lpTotal > 0) {
        const share = line.amount / reg.tiers.lpTotal
        context.push({ label: 'Of which return of capital', value: roundCents(reg.tiers.returnOfCapital * share) })
        if (reg.tiers.preferred > 0) context.push({ label: 'Of which preferred return', value: roundCents(reg.tiers.preferred * share) })
      }
      if (row) context.push({ label: 'Capital account balance', value: row.ending })
    }
    return {
      line,
      partnerName,
      investorId: investorByEntity.get(line.lpEntityId) ?? null,
      data: {
        kind: reg.kind,
        displayFont: displayFontOf((settingsRes as any).data?.theme),
        fundName: letterhead.name,
        fundLogo: letterhead.logo,
        fundAddress: letterhead.address,
        currency,
        vehicle: group,
        partnerName,
        noticeDate: reg.noticeDate,
        number: reg.numberLabel,
        description: line.role === 'carry' ? `${reg.description ?? 'Distribution'} — carried interest` : reg.description,
        amount: line.amount,
        dueDate: reg.dueDate,
        wireInstructions,
        context,
        purposes: reg.purposes ?? null,
        share: reg.purposes && line.role === 'lp' && callTotal > 0 ? line.amount / callTotal : null,
      },
    }
  })
}

export interface NoticeRecipientPreview {
  lpEntityId: string
  name: string
  amount: number
  to: string | null
  cc: string[]
  /** Why nothing would be sent to this partner. */
  skipped: string | null
}

/** Who each partner's notice would go to, without sending. */
export async function previewNoticeRecipients(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  reg: NoticeRegister,
  lpEntityIds: string[] | undefined,
): Promise<{ recipients: NoticeRecipientPreview[]; portalEnabled: boolean; hasProvider: boolean; subject: string; html: string }> {
  const requested = lpEntityIds ?? []
  const targets = requested.length > 0 ? reg.lines.filter(l => requested.includes(l.lpEntityId)) : reg.lines
  const [names, entityRows, fs, fundRes, config] = await Promise.all([
    loadEntityNames(admin, fundId, group),
    admin.from('lp_entities' as any).select('id, investor_id').eq('fund_id', fundId).in('id', targets.map(t => t.lpEntityId)),
    (admin as any).from('fund_settings').select('lp_portal_enabled').eq('fund_id', fundId).maybeSingle(),
    admin.from('funds' as any).select('name').eq('id', fundId).maybeSingle(),
    getOutboundConfig(admin, fundId),
  ])
  const investorByEntity = new Map<string, string | null>(
    (((entityRows as any).data as any[]) ?? []).map(e => [e.id as string, (e.investor_id ?? null) as string | null])
  )
  const investorIds = Array.from(new Set(Array.from(investorByEntity.values()).filter(Boolean) as string[]))
  const groups = await resolveLpRecipients(admin, fundId, investorIds)
  const groupByInvestor = new Map<string, { to: string; cc: string[] }>()
  for (const g of groups) for (const inv of g.investorIds) groupByInvestor.set(inv, { to: g.primaryEmail, cc: g.ccEmails })

  const recipients: NoticeRecipientPreview[] = targets.map(line => {
    const investorId = investorByEntity.get(line.lpEntityId) ?? null
    const g = investorId ? groupByInvestor.get(investorId) : undefined
    return {
      lpEntityId: line.lpEntityId,
      name: names.get(line.lpEntityId) ?? line.lpEntityId,
      amount: line.amount,
      to: g?.to ?? null,
      cc: g?.cc ?? [],
      skipped: !investorId ? 'No linked LP investor' : !g ? 'No portal account yet — invite them from LP Portal → Access' : null,
    }
  })
  // The vehicle's letterhead name where it has one, so the email matches the notice it carries.
  const fundName = (await documentLetterhead(admin, fundId, (fundRes as any).data, [group])).name || 'Your fund'
  const subject = `${fundName}: ${noticeTitle(reg)}`
  const html = buildLpEmailHtml({
    fundName,
    itemTitle: noticeTitle(reg),
    message: '',
    link: `${siteUrl()}/portal/notices`,
    linkLabel: 'View the notice',
    facts: [
      { label: reg.kind === 'capital_call' ? 'Amount due' : 'Amount payable', value: '(each partner’s own amount)' },
      ...(reg.dueDate ? [{ label: 'Due', value: reg.dueDate }] : []),
    ],
  })
  return { recipients, portalEnabled: !!(fs as any)?.data?.lp_portal_enabled, hasProvider: !!config, subject, html }
}
