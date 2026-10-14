// Reopening closed periods, with its reason on the audit trail. One path for the Periods page
// (POST /api/accounting/periods { action: 'reopen' }) and the `reopen_period` agent tool, so a
// reopen from chat records the same event a reopen from the web does.

import type { SupabaseClient } from '@supabase/supabase-js'
import { auditReason, recordAudit } from '@/lib/audit/events'
import { reopenThrough } from './close'
import { vehicleIdByName } from './vehicle-id'

export type ReopenTarget = { periodId: string } | { fromDate: string }

export async function reopenWithAudit(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  target: ReopenTarget,
  rawReason: unknown,
) {
  const reason = auditReason(rawReason)
  if (!reason) return { error: 'A reason is required to reopen a closed period.' }
  const result = await reopenThrough(admin, fundId, group, target)
  if ('error' in result) return result
  await recordAudit(admin, {
    fundId, vehicleId: await vehicleIdByName(admin, fundId, group), actorId: userId,
    action: 'period.reopen', subjectType: 'fiscal_period', subjectId: 'periodId' in target ? target.periodId : null, reason,
    details: { fromDate: 'fromDate' in target ? target.fromDate : null, reopened: result.reopened, voided: result.voided, reopenedPeriods: result.reopenedPeriods, issuedK1Years: result.issuedK1Years },
  })
  return result
}
