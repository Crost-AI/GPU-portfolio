// Recording what became of a K-1 a fund holding owes us: received, amended, or not owed after all.
//
// Shared by the tax page's route (app/api/accounting/received-k1s) and the agent's mark_holding_k_one
// tool. The expectation itself is derived from the holdings (received-k1s.ts); what is stored is only
// the departure from it.

import type { SupabaseClient } from '@supabase/supabase-js'
import { K1_EXPECTED_HOLDING_TYPE } from './received-k1s'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'

export const RECEIVED_K1_STATUSES = ['expected', 'received', 'amended', 'not_expected'] as const

export interface MarkReceivedK1Input {
  companyId: string
  taxYear: number
  status: string
  receivedDate?: string | null
  reportedOrdinaryIncome?: number | null
  reportedCapitalGain?: number | null
  reportedEndingCapital?: number | null
  notes?: string | null
}

/**
 * `vehicleId` is the caller's entity that received it, already checked as theirs, or null for an
 * unscoped caller recording it firm-wide.
 */
export async function markReceivedK1(
  admin: SupabaseClient, fundId: string, userId: string, vehicleId: string | null, body: MarkReceivedK1Input,
): Promise<Outcome<any>> {
  const companyId = typeof body?.companyId === 'string' ? body.companyId : ''
  const taxYear = Number(body?.taxYear)
  if (!companyId || !Number.isInteger(taxYear)) return fail(400, 'companyId and taxYear are required')
  if (!(RECEIVED_K1_STATUSES as readonly string[]).includes(body?.status)) {
    return fail(400, `status must be one of ${RECEIVED_K1_STATUSES.join(', ')}`)
  }

  // The holding must belong to this fund AND be a fund holding. Filtering the discriminator
  // here is stricter than an allowlist would be: only a partnership files a K-1, so marking a
  // portfolio company as owing one is a mistake worth refusing rather than storing.
  const { data: company } = await admin
    .from('companies' as any)
    .select('id')
    .eq('fund_id', fundId)
    .eq('id', companyId)
    .eq('holding_type', K1_EXPECTED_HOLDING_TYPE)
    .maybeSingle()
  if (!company) return fail(400, 'Unknown holding for this fund, or not a fund holding — only a partnership files a K-1.')

  const { data, error } = await admin
    .from('received_k1s' as any)
    .upsert(
      {
        fund_id: fundId,
        vehicle_id: vehicleId,
        company_id: companyId,
        tax_year: taxYear,
        status: body.status,
        received_date: typeof body?.receivedDate === 'string' ? body.receivedDate : null,
        reported_ordinary_income: body?.reportedOrdinaryIncome ?? null,
        reported_capital_gain: body?.reportedCapitalGain ?? null,
        reported_ending_capital: body?.reportedEndingCapital ?? null,
        notes: typeof body?.notes === 'string' ? body.notes.slice(0, 2000) : null,
        created_by: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'company_id,tax_year' },
    )
    .select('*')
    .single()
  if (error) return dbFail(error, 'received-k1s')
  return done(data)
}
