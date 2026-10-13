// Proposed capital calls: a call written down for review before it is issued. Until now a call was
// either previewed (nothing saved) or issued (in the books), with nothing in between for someone
// to check, revise, or hand to an admin to approve.
//
// The life of one:
//   proposed  → created from a request (total, purposes, dates, notice period). Nothing is in the
//               books and no LP can see it. Anyone with LP capital write may propose or revise one.
//   approved  → an ADMIN approves it. The checks are re-run against live commitments and the
//               vehicle's stored LPA notice period; blockers refuse, warnings must be acknowledged.
//               Then the call is issued through `issueCapitalCall` (the path the Capital page uses)
//               and advances are applied as that page applies them. Each LP's own notice is then
//               published to their portal (proposed-call-publish.ts, kept apart because it renders
//               PDFs).
//   discarded → withdrawn. Kept, so the audit trail can point at it.
//
// Every check lives in capital-call-check.ts and is pure. This file only loads what the fund's
// records say and writes the result down.

import type { SupabaseClient } from '@supabase/supabase-js'
import { checkCapitalCall, normalizePurposes, type CallFacts, type ProposedCallRequest, type CheckedCall, type NoticePeriodBasis } from './capital-call-check'
import { approvable, needsAcknowledgement } from '@/lib/drafting/checks'
import { loadOwnership, loadEntityNames } from './load'
import { lpCalledTotals, issueCapitalCall } from './capital-calls'
import { applyAdvancesToCall } from './call-extras'
import { vehicleIdByName } from './vehicle-id'
import { documentLetterhead } from '@/lib/vehicle-letterhead'
import { recordAudit } from '@/lib/audit/events'
import { currentChangeSource } from '@/lib/audit/source'
import { done, fail, dbFail, type Outcome } from '@/lib/service-outcome'

export type ProposedCallStatus = 'proposed' | 'approved' | 'discarded'

export interface ProposedCallContext {
  fundId: string
  /** The vehicle (portfolio_group), already resolved against the caller's entities. */
  group: string
  userId: string | null
}

const TABLE = 'proposed_capital_calls'
const today = () => new Date().toISOString().slice(0, 10)
const validBasis = (v: unknown): NoticePeriodBasis | null => (v === 'calendar' || v === 'business' ? v : null)

/** What the fund's records say about a call on this vehicle. */
export async function loadCallFacts(admin: SupabaseClient, fundId: string, group: string, asOf = today()): Promise<CallFacts> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const settings = async () => {
    const q = (cols: string) => (admin as any).from('vehicle_accounting_settings').select(cols).eq('fund_id', fundId).eq('vehicle_id', vehicleId).maybeSingle()
    const full = await q('wire_instructions, call_notice_days, call_notice_basis')
    // Before the migration adding the notice-period columns is pushed: the wire instructions still count.
    return full.error ? await q('wire_instructions') : full
  }
  const [settingsRes, fundRes, currencyRes, owners, names, called] = await Promise.all([
    settings(),
    (admin as any).from('funds').select('name, logo_url, address').eq('id', fundId).maybeSingle(),
    (admin as any).from('fund_settings').select('currency').eq('fund_id', fundId).maybeSingle(),
    loadOwnership(admin, fundId, group),
    loadEntityNames(admin, fundId, group),
    lpCalledTotals(admin, fundId, group),
  ])
  const s = (settingsRes as any).data ?? {}
  const letterhead = await documentLetterhead(admin, fundId, (fundRes as any).data, [group])
  return {
    vehicle: group,
    currency: (currencyRes as any).data?.currency || 'USD',
    fundAddress: letterhead.address || null,
    wireInstructions: typeof s.wire_instructions === 'string' && s.wire_instructions.trim() ? s.wire_instructions : null,
    storedNoticeDays: Number.isInteger(s.call_notice_days) ? s.call_notice_days : null,
    storedNoticeBasis: validBasis(s.call_notice_basis),
    partners: owners.map(o => ({
      lpEntityId: o.lpEntityId,
      name: names.get(o.lpEntityId) ?? o.lpEntityId,
      commitment: o.commitment,
      calledToDate: called.get(o.lpEntityId) ?? 0,
    })),
    today: asOf,
  }
}

/** The request a stored proposal represents. */
function requestOf(row: any): ProposedCallRequest {
  return {
    total: Number(row.total),
    purposes: normalizePurposes(row.purposes),
    noticeDate: row.notice_date ?? null,
    dueDate: row.due_date ?? null,
    noticePeriodDays: row.notice_period_days ?? null,
    noticePeriodBasis: validBasis(row.notice_period_basis),
    description: row.description ?? null,
  }
}

export interface ProposedCallView extends CheckedCall {
  id: string
  status: ProposedCallStatus
  vehicle: string
  approvable: boolean
  needsAcknowledgement: boolean
  capitalCallId: string | null
  createdAt: string
  approvedAt: string | null
}

function view(row: any, group: string, checked: CheckedCall): ProposedCallView {
  return {
    id: row.id,
    status: row.status,
    vehicle: group,
    ...checked,
    approvable: approvable(checked),
    needsAcknowledgement: needsAcknowledgement(checked),
    capitalCallId: row.capital_call_id ?? null,
    createdAt: row.created_at,
    approvedAt: row.approved_at ?? null,
  }
}

/** A proposal as stored at its last check (approved and discarded ones are not re-checked). */
function frozenCheck(row: any): CheckedCall | null {
  const c = row.checked
  return c && Array.isArray(c.lines) ? (c as CheckedCall) : null
}

function rowFields(req: ProposedCallRequest) {
  return {
    total: req.total,
    purposes: normalizePurposes(req.purposes),
    description: req.description?.trim() || null,
    notice_date: req.noticeDate || null,
    due_date: req.dueDate || null,
    notice_period_days: req.noticePeriodDays ?? null,
    notice_period_basis: req.noticePeriodBasis ?? null,
  }
}

/** Store the parts of a request the table can hold: dates it cannot parse stay out of the row. */
function storable(req: ProposedCallRequest, checked: CheckedCall): ProposedCallRequest {
  return { ...req, noticeDate: checked.noticeDate, dueDate: checked.dueDate }
}

export async function proposeCapitalCall(admin: SupabaseClient, ctx: ProposedCallContext, req: ProposedCallRequest): Promise<Outcome<ProposedCallView>> {
  const vehicleId = await vehicleIdByName(admin, ctx.fundId, ctx.group)
  if (!vehicleId) return fail(400, `"${ctx.group}" is not in this fund's vehicle registry.`)
  const checked = checkCapitalCall(req, await loadCallFacts(admin, ctx.fundId, ctx.group))
  const { data, error } = await (admin as any).from(TABLE).insert({
    fund_id: ctx.fundId, vehicle_id: vehicleId, status: 'proposed',
    ...rowFields(storable(req, checked)),
    checked, created_by: ctx.userId, created_source: currentChangeSource(),
  }).select('*').single()
  if (error) return dbFail(error, 'proposed-calls.create')
  await recordAudit(admin, {
    fundId: ctx.fundId, vehicleId, actorId: ctx.userId, action: 'proposed_call.create',
    subjectType: 'proposed_capital_call', subjectId: (data as any).id,
    details: { total: checked.total, noticeDate: checked.noticeDate, dueDate: checked.dueDate, partners: checked.lines.length, missing: checked.missing.map(m => m.field), flags: checked.flags.map(f => f.code) },
  })
  return done(view(data, ctx.group, checked))
}

async function loadRow(admin: SupabaseClient, ctx: ProposedCallContext, id: string): Promise<Outcome<{ row: any; vehicleId: string }>> {
  const vehicleId = await vehicleIdByName(admin, ctx.fundId, ctx.group)
  if (!vehicleId || !id) return fail(404, 'No proposed capital call with that id on this vehicle.')
  const { data, error } = await (admin as any).from(TABLE).select('*').eq('id', id).eq('fund_id', ctx.fundId).eq('vehicle_id', vehicleId).maybeSingle()
  if (error) return dbFail(error, 'proposed-calls.load')
  if (!data) return fail(404, 'No proposed capital call with that id on this vehicle.')
  return done({ row: data, vehicleId })
}

/**
 * One proposed call. An open one is RE-CHECKED against today's records (a commitment recorded or
 * the LPA notice period set since it was proposed changes the answer); an approved one shows what was
 * approved.
 */
export async function getProposedCall(admin: SupabaseClient, ctx: ProposedCallContext, id: string): Promise<Outcome<ProposedCallView>> {
  const r = await loadRow(admin, ctx, id)
  if (!r.ok) return r
  const { row } = r.value
  const frozen = row.status === 'proposed' ? null : frozenCheck(row)
  const checked = frozen ?? checkCapitalCall(requestOf(row), await loadCallFacts(admin, ctx.fundId, ctx.group))
  return done(view(row, ctx.group, checked))
}

export interface ProposedCallSummary {
  id: string
  status: ProposedCallStatus
  vehicle: string
  total: number
  noticeDate: string | null
  dueDate: string | null
  description: string | null
  capitalCallId: string | null
  createdAt: string
}

/** Drafts on the given vehicles (null = every vehicle the fund has), newest first. */
export async function listProposedCalls(
  admin: SupabaseClient, fundId: string, vehicles: { id: string; name: string }[] | null, status?: ProposedCallStatus,
): Promise<Outcome<ProposedCallSummary[]>> {
  let q = (admin as any).from(TABLE).select('id, status, vehicle_id, total, notice_date, due_date, description, capital_call_id, created_at, fund_vehicles(name)')
    .eq('fund_id', fundId).order('created_at', { ascending: false }).limit(100)
  if (vehicles) q = q.in('vehicle_id', vehicles.map(v => v.id))
  if (status) q = q.eq('status', status)
  const { data, error } = await q
  if (error) return dbFail(error, 'proposed-calls.list')
  return done(((data as any[]) ?? []).map(r => ({
    id: r.id, status: r.status, vehicle: r.fund_vehicles?.name ?? '', total: Number(r.total),
    noticeDate: r.notice_date ?? null, dueDate: r.due_date ?? null, description: r.description ?? null,
    capitalCallId: r.capital_call_id ?? null, createdAt: r.created_at,
  })))
}

/** Change an open proposal. Only the fields given change; the checks run again on the result. */
export async function reviseProposedCall(admin: SupabaseClient, ctx: ProposedCallContext, id: string, patch: Partial<ProposedCallRequest>): Promise<Outcome<ProposedCallView>> {
  const r = await loadRow(admin, ctx, id)
  if (!r.ok) return r
  const { row, vehicleId } = r.value
  if (row.status !== 'proposed') return fail(409, `That call is already ${row.status}; propose a new one.`)
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
  const req: ProposedCallRequest = { ...requestOf(row), ...defined }
  const checked = checkCapitalCall(req, await loadCallFacts(admin, ctx.fundId, ctx.group))
  const { data, error } = await (admin as any).from(TABLE)
    .update({ ...rowFields(storable(req, checked)), checked, updated_at: new Date().toISOString() })
    .eq('id', id).eq('fund_id', ctx.fundId).eq('status', 'proposed').select('*').maybeSingle()
  if (error) return dbFail(error, 'proposed-calls.revise')
  if (!data) return fail(409, 'That proposed call changed while you were editing it. Fetch it again.')
  await recordAudit(admin, {
    fundId: ctx.fundId, vehicleId, actorId: ctx.userId, action: 'proposed_call.revise',
    subjectType: 'proposed_capital_call', subjectId: id, details: { changed: Object.keys(defined) },
  })
  return done(view(data, ctx.group, checked))
}

export async function discardProposedCall(admin: SupabaseClient, ctx: ProposedCallContext, id: string): Promise<Outcome<{ id: string; status: 'discarded' }>> {
  const r = await loadRow(admin, ctx, id)
  if (!r.ok) return r
  if (r.value.row.status !== 'proposed') return fail(409, `That call is already ${r.value.row.status}.`)
  const { error } = await (admin as any).from(TABLE).update({ status: 'discarded', updated_at: new Date().toISOString() })
    .eq('id', id).eq('fund_id', ctx.fundId).eq('status', 'proposed')
  if (error) return dbFail(error, 'proposed-calls.discard')
  await recordAudit(admin, {
    fundId: ctx.fundId, vehicleId: r.value.vehicleId, actorId: ctx.userId, action: 'proposed_call.discard',
    subjectType: 'proposed_capital_call', subjectId: id,
  })
  return done({ id, status: 'discarded' })
}

export interface ApproveOptions {
  /** The approver's fund role. Only an admin may approve (lib/access/admin-only.ts says so too). */
  role: string
  /** Required when the proposal carries warnings or optional missing items. */
  acknowledge?: boolean
}

export interface ApprovedCall {
  id: string
  capitalCallId: string
  /** False when this approval found the call already issued (a retry). */
  issued: boolean
  advancesApplied: Record<string, number>
}

/**
 * Approve: re-check from live records, then issue. Idempotent: an approved proposal returns its call,
 * and the call is issued under a request key derived from the proposal, so a retry after a timeout
 * finds the same call rather than issuing a second.
 */
export async function approveProposedCall(admin: SupabaseClient, ctx: ProposedCallContext, id: string, opts: ApproveOptions): Promise<Outcome<ApprovedCall>> {
  if (opts.role !== 'admin') return fail(403, 'Only an admin can approve a capital call notice.')
  if (!ctx.userId) return fail(403, 'A person has to approve a capital call notice.')
  const r = await loadRow(admin, ctx, id)
  if (!r.ok) return r
  const { row, vehicleId } = r.value
  if (row.status === 'discarded') return fail(409, 'That proposed call was discarded.')

  let callId: string | null = row.capital_call_id ?? null
  let checked: CheckedCall | null = frozenCheck(row)
  let advancesApplied: Record<string, number> = {}
  const issuedNow = row.status === 'proposed'

  if (row.status === 'proposed') {
    checked = checkCapitalCall(requestOf(row), await loadCallFacts(admin, ctx.fundId, ctx.group))
    if (!approvable(checked)) {
      return fail(422, 'This call cannot be approved yet.', {
        missing: checked.missing.filter(m => m.required), flags: checked.flags.filter(f => f.severity === 'blocker'),
      })
    }
    if (needsAcknowledgement(checked) && !opts.acknowledge) {
      return fail(422, 'Approving this call means accepting the warnings below. Approve again with acknowledge set.', {
        missing: checked.missing, flags: checked.flags.filter(f => f.severity === 'warning'),
      })
    }
    const lines = checked.lines.filter(l => l.amount > 0).map(l => ({ lpEntityId: l.lpEntityId, amount: l.amount }))
    const issued = await issueCapitalCall(admin, ctx.fundId, ctx.group, ctx.userId, {
      requestKey: `proposed-call:${id}`,
      callDate: checked.noticeDate!,
      dueDate: checked.dueDate,
      description: checked.description,
      scope: 'fund_wide',
      lines,
    })
    if ('error' in issued) return fail(400, issued.error)
    callId = issued.callId

    // What the call is for, frozen with it for the notice. Tolerated before the column exists.
    await (admin as any).from('capital_calls').update({ purposes: checked.purposes }).eq('id', callId).eq('fund_id', ctx.fundId)

    // As the Capital page does after issuing: money partners sent ahead meets their lines first.
    const adv = await applyAdvancesToCall(admin, ctx.fundId, ctx.group, ctx.userId, {
      callId, callDate: checked.noticeDate!, lines: new Map(lines.map(l => [l.lpEntityId, l.amount])),
    })
    if (!('error' in adv)) advancesApplied = Object.fromEntries(adv.applied)

    const { error } = await (admin as any).from(TABLE).update({
      status: 'approved', capital_call_id: callId, checked, approved_by: ctx.userId,
      approved_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', id).eq('fund_id', ctx.fundId)
    if (error) return dbFail(error, 'proposed-calls.approve')

    await recordAudit(admin, {
      fundId: ctx.fundId, vehicleId, actorId: ctx.userId, action: 'capital_call.issue',
      subjectType: 'capital_call', subjectId: callId,
      details: { fromDraft: id, callDate: checked.noticeDate, dueDate: checked.dueDate, total: checked.total, partners: lines.length, advancesApplied },
    })
    await recordAudit(admin, {
      fundId: ctx.fundId, vehicleId, actorId: ctx.userId, action: 'proposed_call.approve',
      subjectType: 'proposed_capital_call', subjectId: id,
      details: { capitalCallId: callId, acknowledged: checked.flags.filter(f => f.severity === 'warning').map(f => f.code).concat(checked.missing.map(m => m.field)) },
    })
  }
  if (!callId) return fail(409, 'That proposal was approved but has no call. Ask an admin to check the Capital page.')
  return done({ id, capitalCallId: callId, issued: issuedNow, advancesApplied })
}
