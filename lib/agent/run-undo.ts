// Undo for what an approved run (lib/agent/run-action.ts) created.
//
// A run is not one database transaction: each step runs through its tool's own handler, which
// commits as it goes, exactly as the same call would one at a time. So a run that stops halfway,
// or whose expected checks fail, leaves its earlier steps applied. Undo is the way back, scoped to
// what can be taken back SAFELY:
//
//   * a journal entry the run created (post_entry, a posted allocation) is voided, as the journal's
//     Void does. Refused when its period is closed, when investment transactions own it (deleting
//     them is a holding change the run did not make), or when it is half of an investment reversal
//     pair. Voiding a POSTED entry is admin-only (HANDLER_CHECKED.voidPostedEntry), as in the app.
//   * an investment transaction the run recorded (record_investment) is deleted through the
//     company page's own delete (lib/portfolio/transaction-edit.ts), which retracts its entry
//     first and refuses when that entry sits in a closed period.
//
// Everything else a run can do (edits, deletes, posting existing drafts, settings) has no stored
// prior state to restore, and is reported as not undoable rather than guessed at.

import type { SupabaseClient } from '@supabase/supabase-js'
import { adminOnlyDenial, HANDLER_CHECKED } from '@/lib/access/admin-only'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { hasAccess } from '@/lib/access/effective'
import { recordAudit } from '@/lib/audit/events'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { setGeneratedAllocationStatus } from '@/lib/accounting/continuous-allocation'
import { isInvestmentAccount, loadVehicleChart } from '@/lib/accounting/investment-accounts'
import { isLiveInvestmentReversalHalf, planRelease } from '@/lib/accounting/ownership'
import { closedPeriodRanges, dateInAnyClosedPeriod } from '@/lib/accounting/periods'
import { resolveVehicleWithAccess } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { deleteInvestmentTransaction } from '@/lib/portfolio/transaction-edit'
import type { ActionDeps } from '@/lib/pending-actions/types'

export type UndoTarget =
  | { kind: 'journal_entry'; id: string; vehicle: string }
  | { kind: 'investment_transaction'; id: string; companyId: string }

export interface UndoOutcome {
  step: number
  target: UndoTarget
  status: 'undone' | 'already' | 'refused' | 'failed'
  message?: string
}

/** What a step's result says it created, by tool. An empty list means nothing this can undo. */
export function undoTargetsFor(tool: string, input: Record<string, unknown>, result: unknown): UndoTarget[] {
  const r = (result ?? {}) as Record<string, any>
  const vehicle = typeof input.vehicle === 'string' ? input.vehicle : ''
  if ((tool === 'post_entry' || tool === 'allocation') && typeof r.entryId === 'string' && vehicle) {
    return [{ kind: 'journal_entry', id: r.entryId, vehicle }]
  }
  if (tool === 'record_investment' && typeof r.transaction?.id === 'string' && typeof r.transaction?.company_id === 'string') {
    return [{ kind: 'investment_transaction', id: r.transaction.id, companyId: r.transaction.company_id }]
  }
  return []
}

/** Why a step cannot be undone here, for the approver; null when it can. */
export function notUndoableReason(tool: string, targets: UndoTarget[]): string | null {
  if (targets.length > 0) return null
  return `${tool} cannot be undone from here; correct it by hand if needed.`
}

/** Undo every target, last step first. Never throws: each target reports its own outcome. */
export async function undoTargets(
  deps: ActionDeps & { role: string },
  steps: { step: number; targets: UndoTarget[] }[],
  context: { runId: string; title: string },
): Promise<UndoOutcome[]> {
  const out: UndoOutcome[] = []
  for (const { step, targets } of [...steps].sort((a, b) => b.step - a.step)) {
    for (const target of [...targets].reverse()) {
      try {
        const res = target.kind === 'journal_entry'
          ? await voidEntry(deps, target, context)
          : await deleteTransaction(deps, target)
        out.push({ step, target, ...res })
      } catch (e) {
        out.push({ step, target, status: 'failed', message: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  return out
}

type Res = { status: UndoOutcome['status']; message?: string }

async function voidEntry(
  deps: ActionDeps & { role: string },
  target: Extract<UndoTarget, { kind: 'journal_entry' }>,
  context: { runId: string; title: string },
): Promise<Res> {
  const { admin, fundId, access } = deps
  if (!hasAccess(access, 'accounting', 'write')) return { status: 'refused', message: 'Voiding an entry needs write access to Fund accounting.' }
  const vehicle = await resolveVehicleWithAccess(admin, access, target.vehicle, 'write')
  const vehicleId = await vehicleIdByName(admin, fundId, vehicle.name)
  if (!vehicleId) return { status: 'failed', message: `Unknown vehicle ${target.vehicle}.` }

  const { data: existing, error } = await (admin as any).from('journal_entries')
    .select('id, status, entry_date, memo, reference, reversed_by, source_ref')
    .eq('book', ACTUAL_BOOK).eq('id', target.id).eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!existing) return { status: 'failed', message: 'The entry is no longer there.' }
  const status = (existing as any).status as string
  if (status === 'void') return { status: 'already', message: 'Already void.' }
  if (status === 'posted') {
    const denial = adminOnlyDenial(deps.role, HANDLER_CHECKED.voidPostedEntry)
    if (denial) return { status: 'refused', message: denial }
  }
  if (dateInAnyClosedPeriod(await closedPeriodRanges(admin, fundId, vehicle.name), (existing as any).entry_date)) {
    return { status: 'refused', message: 'The entry is in a closed period. Reopen it or post a reversal instead.' }
  }
  const chart = await loadVehicleChart(admin, fundId, vehicleId)
  const investment = new Set(chart.filter(isInvestmentAccount).map(a => a.id))
  if (await isLiveInvestmentReversalHalf(admin, fundId, existing as any, investment)) {
    return { status: 'refused', message: 'The entry is half of an investment reversal pair; reverse it from the journal instead.' }
  }
  const plan = await planRelease(admin, fundId, existing as any)
  if ('error' in plan) return { status: 'failed', message: plan.error }
  if (plan.removed.length > 0 || plan.unlinked.length > 0) {
    return { status: 'refused', message: 'Investment transactions own this entry; delete them from the company page instead.' }
  }

  const linked = await setGeneratedAllocationStatus(admin, fundId, target.id, 'void')
  if (linked.error) return { status: 'failed', message: linked.error }
  const { data: voided, error: voidErr } = await (admin as any).from('journal_entries')
    .update({ status: 'void', posted_at: null })
    .eq('book', ACTUAL_BOOK).eq('id', target.id).eq('fund_id', fundId).eq('status', status)
    .select('id')
  if (voidErr) throw new Error(voidErr.message)
  if (!voided?.length) return { status: 'failed', message: 'The entry changed while it was being voided. Check it in the journal.' }
  await (admin as any).from('bank_transactions').update({ status: 'ignored' }).eq('journal_entry_id', target.id).eq('fund_id', fundId)
  await recordAudit(admin as SupabaseClient, {
    fundId, vehicleId, actorId: deps.userId, action: 'entry.void', subjectType: 'journal_entry', subjectId: target.id,
    reason: `Undo of approved run "${context.title}"`.slice(0, 1000),
    details: {
      entryDate: (existing as any).entry_date, memo: (existing as any).memo ?? null, reference: (existing as any).reference ?? null,
      priorStatus: status, runId: context.runId,
    },
  })
  return { status: 'undone' }
}

async function deleteTransaction(deps: ActionDeps, target: Extract<UndoTarget, { kind: 'investment_transaction' }>): Promise<Res> {
  const { admin, fundId, userId, access } = deps
  // The same gate as delete_investment and the company page's delete.
  if (!hasAccess(access, 'portfolio', 'write', 'investments')) {
    return { status: 'refused', message: 'Deleting an investment transaction needs write access to investments.' }
  }
  const { data: still } = await (admin as any).from('investment_transactions').select('id').eq('id', target.id).eq('fund_id', fundId).maybeSingle()
  if (!still) return { status: 'already', message: 'Already deleted.' }
  const vehicleNames = (await entityScopeFor(admin, access)).vehicleNames
  const outcome = await deleteInvestmentTransaction(admin, { fundId, userId, vehicleNames }, target.companyId, target.id)
  return outcome.ok ? { status: 'undone' } : { status: 'refused', message: outcome.error }
}
