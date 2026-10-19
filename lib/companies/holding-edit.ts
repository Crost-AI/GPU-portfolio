// Renaming a holding, its aliases, and what kind of holding it is, for the `update_company` and
// `set_holding_type` agent tools.
//
// A rename also renames the holding's own chart accounts ("Investment — <name>" and the rest, made
// by lib/accounting/investments.ts ensureInvestmentAccounts), so the trial balance reads the same
// name as the portfolio. Only accounts still carrying the old name are touched: one renamed by hand
// keeps its name.
//
// The holding type decides which page owns the record. A company becoming a fund holding gains a
// register (terms, notices, NAV statements); a fund holding becoming a company is refused while it
// has one, because the register would keep owning its transactions (clear_fund_register removes it).

import type { SupabaseClient } from '@supabase/supabase-js'
import { logActivity } from '@/lib/activity'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'

export type HoldingType = 'company' | 'fund' | 'crypto'
const HOLDING_TYPES: HoldingType[] = ['company', 'fund', 'crypto']
const STATUSES = ['active', 'exited', 'written-off']

const ACCOUNT_PREFIXES = ['Investment', 'Unrealized', 'FX translation', 'Accrued interest', 'Realized gain']

export interface IdentityChange {
  name?: string
  aliases?: string[]
  /** Added to the aliases already there, without duplicates. */
  addAliases?: string[]
  status?: string
}

export async function updateCompanyIdentity(
  admin: SupabaseClient,
  who: { fundId: string; userId: string | null },
  companyId: string,
  change: IdentityChange,
): Promise<Outcome<{ id: string; name: string; previousName: string; aliases: string[]; status: string | null; accountsRenamed: number }>> {
  const { data: company, error } = await (admin as any)
    .from('companies').select('id, name, aliases, status').eq('id', companyId).eq('fund_id', who.fundId).maybeSingle()
  if (error) return dbFail(error, 'company-identity')
  if (!company) return fail(404, 'Company not found')

  const updates: Record<string, unknown> = {}
  const name = change.name?.trim()
  if (change.name !== undefined && !name) return fail(400, 'Name cannot be empty.')
  if (name && name !== company.name) updates.name = name

  const clean = (list: unknown) => (Array.isArray(list) ? list : [])
    .filter((a): a is string => typeof a === 'string' && !!a.trim()).map(a => a.trim())
  let aliases = change.aliases !== undefined ? clean(change.aliases) : clean(company.aliases)
  for (const a of clean(change.addAliases)) {
    if (!aliases.some(x => x.toLowerCase() === a.toLowerCase())) aliases.push(a)
  }
  // The name it now goes by is not an alias of itself.
  const finalName = (updates.name as string | undefined) ?? company.name
  aliases = aliases.filter(a => a.toLowerCase() !== String(finalName).toLowerCase())
  if (change.aliases !== undefined || change.addAliases !== undefined) updates.aliases = aliases

  if (change.status !== undefined) {
    if (!STATUSES.includes(change.status)) return fail(400, `status must be one of: ${STATUSES.join(', ')}.`)
    updates.status = change.status
  }
  if (Object.keys(updates).length === 0) return fail(400, 'Nothing to change.')

  const { error: updateError } = await (admin as any).from('companies').update(updates).eq('id', companyId).eq('fund_id', who.fundId)
  if (updateError) return dbFail(updateError, 'company-identity')

  let accountsRenamed = 0
  if (updates.name) {
    const { data: accounts } = await (admin as any)
      .from('chart_of_accounts').select('id, name').eq('fund_id', who.fundId).eq('company_id', companyId)
    for (const a of (accounts as any[]) ?? []) {
      const prefix = ACCOUNT_PREFIXES.find(p => a.name === `${p} — ${company.name}`)
      if (!prefix) continue
      const { error: renameError } = await (admin as any).from('chart_of_accounts')
        .update({ name: `${prefix} — ${updates.name}` }).eq('id', a.id).eq('fund_id', who.fundId)
      if (!renameError) accountsRenamed++
    }
  }

  if (who.userId) logActivity(admin, who.fundId, who.userId, 'company.update', { companyId })
  return done({
    id: companyId,
    name: finalName,
    previousName: company.name,
    aliases: (updates.aliases as string[] | undefined) ?? clean(company.aliases),
    status: (updates.status as string | undefined) ?? company.status ?? null,
    accountsRenamed,
  })
}

export async function setHoldingType(
  admin: SupabaseClient,
  who: { fundId: string; userId: string | null },
  companyId: string,
  type: HoldingType,
): Promise<Outcome<{ id: string; name: string; from: HoldingType; to: HoldingType }>> {
  if (!HOLDING_TYPES.includes(type)) return fail(400, `holding_type must be one of: ${HOLDING_TYPES.join(', ')}.`)
  const { data: company, error } = await (admin as any)
    .from('companies').select('id, name, holding_type').eq('id', companyId).eq('fund_id', who.fundId).maybeSingle()
  if (error) return dbFail(error, 'company-holding-type')
  if (!company) return fail(404, 'Company not found')
  const from = (company.holding_type ?? 'company') as HoldingType
  if (from === type) return fail(400, `${company.name} is already a ${type === 'fund' ? 'fund holding' : type === 'crypto' ? 'digital asset' : 'company'}.`)

  if (from === 'fund') {
    const counts = await Promise.all(['fund_capital_events', 'fund_nav_statements'].map(t =>
      (admin as any).from(t).select('id', { count: 'exact', head: true }).eq('fund_id', who.fundId).eq('company_id', companyId)))
    const failed = counts.find(c => c.error)
    if (failed) return dbFail(failed.error, 'company-holding-type')
    const n = counts.reduce((s, c) => s + (c.count ?? 0), 0)
    if (n > 0) {
      return fail(409, `${company.name} has ${n} capital notice(s) and NAV statement(s) in its fund register. `
        + 'Change it first, then clear the register with clear_fund_register.')
    }
  }
  if (type === 'crypto' || from === 'crypto') {
    // A digital asset carries wallets and a price feed the other kinds do not have.
    return fail(400, 'Changing to or from a digital asset is done on the company page.')
  }

  const { error: updateError } = await (admin as any)
    .from('companies').update({ holding_type: type }).eq('id', companyId).eq('fund_id', who.fundId)
  if (updateError) return dbFail(updateError, 'company-holding-type')

  if (who.userId) logActivity(admin, who.fundId, who.userId, 'company.holding_type', { companyId, from, to: type })
  return done({ id: companyId, name: company.name, from, to: type })
}
