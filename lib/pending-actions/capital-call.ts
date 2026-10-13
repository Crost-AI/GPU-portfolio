import type { ActionDeps, PreviewResult } from './types'
import { proRataCall, issueCapitalCall } from '@/lib/accounting/capital-calls'
import { loadOwnership, loadEntityNames } from '@/lib/accounting/load'
import { resolveVehicle } from '@/lib/accounting/agent-tools'
import { checkCapitalCall, normalizePurposes, type CallPurpose, type NoticePeriodBasis } from '@/lib/accounting/capital-call-check'
import { loadCallFacts } from '@/lib/accounting/proposed-calls'

export interface IssueCapitalCallInput {
  vehicle?: string
  callDate: string
  description?: string | null
  /** Fund-wide amount to split across LPs pro-rata by commitment. */
  total: number
  dueDate?: string | null
  /** What the call is for, with amounts. Frozen on the call and shown on each LP's notice. */
  purposes?: CallPurpose[] | null
  /** The LPA notice period as the user stated it. The vehicle's recorded term is checked too. */
  noticePeriodDays?: number | null
  noticePeriodBasis?: NoticePeriodBasis | null
}

/**
 * The same checks a proposed call gets (lib/accounting/capital-call-check.ts), with the call date
 * as the notice date. The approver reads them in the preview; a blocker refuses the execute.
 */
async function checkInput(deps: ActionDeps, group: string, input: IssueCapitalCallInput) {
  const facts = await loadCallFacts(deps.admin, deps.fundId, group)
  return checkCapitalCall({
    total: input.total,
    purposes: input.purposes ?? [],
    noticeDate: input.callDate,
    dueDate: input.dueDate ?? null,
    noticePeriodDays: input.noticePeriodDays ?? null,
    noticePeriodBasis: input.noticePeriodBasis ?? null,
    description: input.description ?? null,
  }, facts)
}

/**
 * Read-only preview of a fund-wide capital call: resolve the vehicle, compute the per-LP pro-rata
 * split by commitment, and surface each LP's commitment + amount and the rounded total — WITHOUT
 * posting anything. `proRataCall` and the ownership/name loads are all reads.
 */
export async function previewIssueCapitalCall(deps: ActionDeps, input: IssueCapitalCallInput): Promise<PreviewResult> {
  const group = await resolveVehicle(deps.admin, deps.fundId, input.vehicle, { access: deps.access })

  const [lines, owners, names, checked] = await Promise.all([
    proRataCall(deps.admin, deps.fundId, group, input.total),
    loadOwnership(deps.admin, deps.fundId, group),
    loadEntityNames(deps.admin, deps.fundId, group),
    checkInput(deps, group, input),
  ])
  const commitmentByLp = new Map(owners.map(o => [o.lpEntityId, o.commitment]))
  const perLp = lines.map(l => ({
    lp: names.get(l.lpEntityId) ?? l.lpEntityId,
    commitment: commitmentByLp.get(l.lpEntityId) ?? 0,
    amount: l.amount,
  }))
  const total = lines.reduce((s, l) => s + l.amount, 0)

  return {
    summary: `Issue a ${input.total} capital call across ${lines.length} LP${lines.length === 1 ? '' : 's'} on ${input.callDate}`,
    details: {
      vehicle: group, callDate: input.callDate, dueDate: input.dueDate ?? null, total, perLp,
      purposes: checked.purposes, earliestDueDate: checked.earliestDueDate,
      missing: checked.missing, flags: checked.flags,
    },
  }
}

/**
 * Execute the call: recompute the pro-rata split from LIVE commitments (so a stale preview can't
 * post outdated amounts) and issue it through the same `issueCapitalCall` path the accounting UI
 * uses. Posts the receivable/capital entry and records the call + lines. Refuses what the checks
 * call a blocker (purposes that don't add up, a due date before the call, more than an LP has
 * left uncalled); warnings were the approver's to read in the preview.
 */
export async function executeIssueCapitalCall(deps: ActionDeps, input: IssueCapitalCallInput): Promise<{ callId: string }> {
  const group = await resolveVehicle(deps.admin, deps.fundId, input.vehicle, { access: deps.access })
  const checked = await checkInput(deps, group, input)
  const blockers = checked.flags.filter(f => f.severity === 'blocker')
  if (blockers.length > 0) throw new Error(blockers.map(f => f.message).join(' '))
  const lines = await proRataCall(deps.admin, deps.fundId, group, input.total)
  const result = await issueCapitalCall(deps.admin, deps.fundId, group, deps.userId, {
    callDate: input.callDate,
    dueDate: input.dueDate ?? null,
    description: input.description ?? null,
    scope: 'fund_wide',
    lines,
  })
  if ('error' in result) throw new Error(result.error)
  const purposes = normalizePurposes(input.purposes ?? [])
  if (purposes.length > 0) {
    await (deps.admin as any).from('capital_calls').update({ purposes }).eq('id', result.callId).eq('fund_id', deps.fundId)
  }
  return { callId: result.callId }
}
