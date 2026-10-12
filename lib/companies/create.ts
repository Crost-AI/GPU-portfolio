/**
 * Creating a portfolio holding: the companies route (POST /api/companies) and the agent's
 * `create_company` tool both come through here, so a company made from chat is linked to the same
 * entities, seeded with the same default metrics and logged the same way as one made in the app.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logActivity } from '@/lib/activity'
import { seedCompanyFromDefaults } from '@/lib/metrics/seed-default-metrics'
import { ensureVehiclesByName } from '@/lib/accounting/vehicle-id'
import { newCompanyGroupsProblem } from '@/lib/access/scope'

export interface CompanyFields {
  name: string
  aliases?: string[] | null
  tags?: string[] | null
  stage?: string | null
  industry?: string[] | null
  notes?: string | null
  overview?: string | null
  founders?: string | null
  why_invested?: string | null
  current_update?: string | null
  contact_email?: string[] | null
  portfolio_group?: string[] | null
}

export type CreateCompanyResult =
  | { ok: true; company: any }
  | { ok: false; status: number; error: string; dbError?: unknown }

const trimOrNull = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

export async function createCompany(
  admin: SupabaseClient,
  opts: {
    fundId: string
    userId: string
    /** The caller's entity names, or null for an admin who sees them all (lib/access/entity-scope.ts). */
    vehicleNames: string[] | null
    fields: CompanyFields
    holdingType?: 'company' | 'crypto'
    /** The metric defaults to seed; omitted seeds every active default. */
    defaultMetricIds?: string[]
  },
): Promise<CreateCompanyResult> {
  const { fundId, userId, fields } = opts
  const holdingType = opts.holdingType ?? 'company'
  const name = trimOrNull(fields.name)
  if (!name) return { ok: false, status: 400, error: 'Name is required' }

  // A member creates a company only in their own entities, and must name one (an unlinked company is
  // admin-only). Checked before ensureVehiclesByName, which would create an entity they cannot see.
  const groupProblem = newCompanyGroupsProblem(opts.vehicleNames, fields.portfolio_group)
  if (groupProblem) return { ok: false, status: 403, error: groupProblem }

  // Every stored portfolio_group name must be backed by a real fund_vehicles row — never a
  // disconnected string. Resolve/create before the write, not after.
  await ensureVehiclesByName(admin, fundId, fields.portfolio_group ?? [])

  const { data, error } = await (admin as any)
    .from('companies')
    .insert({
      fund_id: fundId,
      name,
      aliases: fields.aliases ?? null,
      tags: fields.tags ?? [],
      stage: trimOrNull(fields.stage),
      industry: fields.industry ?? null,
      notes: trimOrNull(fields.notes),
      overview: trimOrNull(fields.overview),
      founders: trimOrNull(fields.founders),
      why_invested: trimOrNull(fields.why_invested),
      current_update: trimOrNull(fields.current_update),
      contact_email: fields.contact_email ?? null,
      portfolio_group: fields.portfolio_group ?? null,
      status: 'active',
      holding_type: holdingType,
    })
    .select()
    .single()
  if (error || !data) return { ok: false, status: 500, error: 'Could not create the company', dbError: error }

  // Company metrics (MRR, cash, burn) describe an operating company. A token has none, and seeding
  // them would put empty charts on its page.
  if (holdingType === 'company') await seedCompanyFromDefaults(admin, fundId, data.id, opts.defaultMetricIds)

  logActivity(admin, fundId, userId, 'company.create', { companyName: name })
  return { ok: true, company: data }
}
