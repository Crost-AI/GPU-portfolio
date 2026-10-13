// The real approval of a staged publish_call_notices (call-notices.ts). Imported only by the
// browser's approve route, which ships Chromium (lib/pdf-routes.mjs): rendering each partner's
// notice launches it.

import type { ActionDeps } from './types'
import { resolveVehicle } from '@/lib/accounting/vehicle-resolver'
import { reviewCallNotices } from '@/lib/accounting/call-notice-review'
import { loadNoticeRegister, publishNotices } from '@/lib/accounting/notices'
import { unwrap } from '@/lib/service-outcome'
import { STALE_PREVIEW_MESSAGE, type PublishCallNoticesInput } from './call-notices'

export async function executePublishCallNotices(deps: ActionDeps, input: PublishCallNoticesInput): Promise<Record<string, unknown>> {
  const group = await resolveVehicle(deps.admin, deps.fundId, input.vehicle, { access: deps.access })
  const callId = String(input.callId ?? '')
  // Re-read now: what goes out must be what the approver was shown.
  const review = unwrap(await reviewCallNotices(deps.admin, { fundId: deps.fundId, group }, callId, { lpEntityIds: input.lpEntityIds }))
  if (input.previewToken !== review.previewToken) throw new Error(STALE_PREVIEW_MESSAGE)
  const blockers = review.flags.filter(f => f.severity === 'blocker')
  if (blockers.length) throw new Error(blockers.map(f => f.message).join(' '))

  const reg = await loadNoticeRegister(deps.admin, deps.fundId, group, 'capital_call', callId)
  if ('error' in reg) throw new Error(reg.error)
  const lpEntityIds = review.partners.map(p => p.lpEntityId)
  const { published, errors } = await publishNotices(deps.admin, { fundId: deps.fundId, group, userId: deps.userId }, reg, { lpEntityIds })
  return {
    callId,
    published: published.filter(p => !p.reused).length,
    reused: published.filter(p => p.reused).length,
    errors,
  }
}
