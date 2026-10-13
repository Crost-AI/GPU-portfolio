// Publishing an issued capital call's notices, staged from a chat (the Analyst, or a connected
// assistant through publish_call_notices) and approved in the app.
//
// Two confirmations, by design. The chat must show the review first (preview_call_notices) and
// stage with its preview token, so the person has read what would go out before asking for it.
// Then a person approves it in the app, where each partner's notice can be opened as a DRAFT PDF,
// and confirms the approval a second time. The approval runs only from the browser route, which
// supplies the real executor (call-notices-publish.ts); anywhere else (approve_action over MCP,
// /api/v1) it is refused, because nothing there can show the notices or ask twice.

import type { ActionDeps, PreviewResult } from './types'
import { resolveVehicle } from '@/lib/accounting/vehicle-resolver'
import { describeCallNotices, reviewCallNotices } from '@/lib/accounting/call-notice-review'

export interface PublishCallNoticesInput {
  vehicle?: string
  callId: string
  /** Only these partners; omitted = every partner on the call. */
  lpEntityIds?: string[] | null
  /** From preview_call_notices: what the person was shown. */
  previewToken: string
}

export const CONFIRM_IN_APP_MESSAGE =
  'Publishing notices to LPs is approved in the app, under Approvals, where each notice can be previewed ' +
  'and the approval is confirmed twice. It cannot be approved from here.'

export const STALE_PREVIEW_MESSAGE =
  'These notices have changed since they were previewed (an amount, a date, the purposes, the wire instructions or a ' +
  'partner\'s notice). Nothing was published. Reject this, preview the notices again and stage a new request.'

/** The review, as the approver sees it. Never throws on a stale token: the row must stay visible to be rejected. */
export async function previewPublishCallNotices(deps: ActionDeps, input: PublishCallNoticesInput): Promise<PreviewResult> {
  // An entity outside the caller's access throws here: that is what hides the row from them.
  const group = await resolveVehicle(deps.admin, deps.fundId, input.vehicle, { access: deps.access })
  const out = await reviewCallNotices(deps.admin, { fundId: deps.fundId, group }, String(input.callId ?? ''), { lpEntityIds: input.lpEntityIds })
  // A call voided or changed so it can no longer be noticed still shows, as a blocker, so it can be rejected.
  if (!out.ok) {
    return {
      summary: `Publish notices for a capital call on ${group} that can no longer be noticed.`,
      details: { vehicle: group, flags: [{ code: 'not_noticeable', severity: 'blocker', message: out.error }] },
    }
  }
  const review = out.value
  const flags = input.previewToken === review.previewToken
    ? review.flags
    : [{ code: 'changed_since_preview', severity: 'blocker' as const, message: STALE_PREVIEW_MESSAGE }, ...review.flags]
  return {
    summary: describeCallNotices(review),
    details: {
      vehicle: group,
      call: review.call,
      partners: review.partners,
      newNotices: review.newNotices,
      earliestDueDate: review.earliestDueDate,
      missing: review.missing,
      flags,
    },
  }
}

/** Off the browser route there is no executor: refuse, saying where it is approved. */
export async function executePublishCallNoticesElsewhere(): Promise<Record<string, unknown>> {
  throw new Error(CONFIRM_IN_APP_MESSAGE)
}
