// Merging two records of the same holding, for the `merge_companies` agent tool: a duplicate made by
// an import (the bank's payee on one, the fund's name on the other) or a cost booked on one record
// and the register on another.
//
// Everything that carries value moves to the record that is kept, through the paths that keep the
// books right:
//   - each investment transaction is moved with moveInvestmentTransaction, which retracts its
//     journal entry and re-derives it on the kept record's accounts (cash does not move);
//   - fund-register rows (terms, notices, NAV statements) move with their transactions;
//   - notes, documents, updates and received K-1s move as they are, and metrics the kept record
//     does not already track.
// The merged record's name and aliases become aliases of the kept one, so imports and emailed
// updates still match it. The merged record is then deleted. When its accounts still carry postings
// (the voided entries the moves left behind), the delete is refused and the empty record is kept,
// with its accounts deactivated; the result says so.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logActivity } from '@/lib/activity'
import type { EntityScope } from '@/lib/access/entity-scope'
import { deleteCompany } from '@/lib/companies/delete'
import { deleteFundHolding } from '@/lib/portfolio/fund-holding-delete'
import { moveInvestmentTransaction } from '@/lib/portfolio/transaction-edit'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'

/** Rows that follow the holding as they are. */
export const MERGE_MOVED_TABLES = [
  'company_notes', 'company_documents', 'company_updates', 'company_update_artifacts', 'company_update_chunks',
  'inbound_emails', 'company_summaries', 'received_k1s',
] as const

export interface MergeResult {
  from: { id: string; name: string }
  into: { id: string; name: string }
  transactionsMoved: number
  registerRowsMoved: number
  /** Terms rows of the merged record on an entity where the kept one already had terms: dropped. */
  termsDropped: number
  rowsMoved: Record<string, number>
  aliases: string[]
  /** True when the merged record was deleted; otherwise why it was kept. */
  deleted: boolean
  keptBecause?: string
  warnings: string[]
}

export async function mergeCompanies(
  admin: SupabaseClient,
  who: { fundId: string; userId: string; vehicleNames: string[] | null },
  fromId: string,
  intoId: string,
  loadScope: () => Promise<Pick<EntityScope, 'access' | 'vehicleNames'>>,
): Promise<Outcome<MergeResult>> {
  if (fromId === intoId) return fail(400, 'Choose two different records to merge.')
  const { data: rows, error } = await (admin as any)
    .from('companies').select('id, name, aliases, holding_type, portfolio_group').eq('fund_id', who.fundId).in('id', [fromId, intoId])
  if (error) return dbFail(error, 'company-merge')
  const from = ((rows as any[]) ?? []).find(r => r.id === fromId)
  const into = ((rows as any[]) ?? []).find(r => r.id === intoId)
  if (!from || !into) return fail(404, 'Company not found')

  // The register follows its transactions, and only a fund holding has one.
  const where = (t: string) => (admin as any).from(t).select('*').eq('fund_id', who.fundId).eq('company_id', fromId)
  const [events, navs, terms] = await Promise.all([where('fund_capital_events'), where('fund_nav_statements'), where('fund_holding_terms')])
  const readFailed = events.error ?? navs.error ?? terms.error
  if (readFailed) return dbFail(readFailed, 'company-merge')
  const register = { events: (events.data as any[]) ?? [], navs: (navs.data as any[]) ?? [], terms: (terms.data as any[]) ?? [] }
  if ((register.events.length || register.navs.length || register.terms.length) && into.holding_type !== 'fund') {
    return fail(400, `${from.name} has a fund register and ${into.name} is not a fund holding. Make ${into.name} a fund holding first (set_holding_type).`)
  }
  if (register.navs.length) {
    const { data: intoNavs } = await (admin as any).from('fund_nav_statements').select('vehicle_id, as_of_date')
      .eq('fund_id', who.fundId).eq('company_id', intoId)
    const taken = new Set(((intoNavs as any[]) ?? []).map(n => `${n.vehicle_id}|${n.as_of_date}`))
    const clash = register.navs.find(n => taken.has(`${n.vehicle_id}|${n.as_of_date}`))
    if (clash) return fail(409, `Both records have a NAV statement dated ${clash.as_of_date} on the same entity. Delete one of them first.`)
  }

  // 1. Transactions, each re-derived on the kept record's accounts.
  const { data: txns, error: txnError } = await (admin as any)
    .from('investment_transactions').select('id, transaction_date').eq('fund_id', who.fundId).eq('company_id', fromId)
    .order('transaction_date', { ascending: true })
  if (txnError) return dbFail(txnError, 'company-merge')
  let transactionsMoved = 0
  const warnings: string[] = []
  for (const t of (txns as any[]) ?? []) {
    const moved = await moveInvestmentTransaction(admin, who, fromId, t.id, intoId, { merging: true })
    if (!moved.ok) {
      return fail(moved.status, `Stopped after moving ${transactionsMoved} transaction(s): the one dated ${t.transaction_date} could not be moved. ${moved.error}`)
    }
    if (moved.value.ledger?.warning) warnings.push(moved.value.ledger.warning)
    if (moved.value.ledger && moved.value.ledger.drafted === false && moved.value.ledger.reason) warnings.push(moved.value.ledger.reason)
    transactionsMoved++
  }

  // 2. The register.
  let registerRowsMoved = 0
  for (const table of ['fund_capital_events', 'fund_nav_statements'] as const) {
    const { data, error: moveError } = await (admin as any).from(table).update({ company_id: intoId })
      .eq('fund_id', who.fundId).eq('company_id', fromId).select('id')
    if (moveError) return dbFail(moveError, 'company-merge-register')
    registerRowsMoved += ((data as any[]) ?? []).length
  }
  let termsDropped = 0
  if (register.terms.length) {
    const { data: intoTerms } = await (admin as any).from('fund_holding_terms').select('vehicle_id').eq('fund_id', who.fundId).eq('company_id', intoId)
    const held = new Set(((intoTerms as any[]) ?? []).map(t => String(t.vehicle_id)))
    for (const t of register.terms) {
      if (held.has(String(t.vehicle_id))) {
        await (admin as any).from('fund_holding_terms').delete().eq('id', t.id).eq('fund_id', who.fundId)
        termsDropped++
      } else {
        await (admin as any).from('fund_holding_terms').update({ company_id: intoId }).eq('id', t.id).eq('fund_id', who.fundId)
        registerRowsMoved++
      }
    }
  }

  // 3. What follows the holding as it is.
  const rowsMoved: Record<string, number> = {}
  for (const table of MERGE_MOVED_TABLES) {
    const { data, error: moveError } = await (admin as any).from(table).update({ company_id: intoId })
      .eq('fund_id', who.fundId).eq('company_id', fromId).select('id')
    if (moveError) warnings.push(`${table} could not be moved: ${moveError.message}`)
    else if (((data as any[]) ?? []).length) rowsMoved[table] = ((data as any[]) ?? []).length
  }

  // Metrics the kept record does not already track move with their values; one it tracks under the
  // same slug stays behind (and goes with the merged record).
  const [{ data: fromMetrics }, { data: intoMetrics }] = await Promise.all([
    (admin as any).from('metrics').select('id, slug').eq('fund_id', who.fundId).eq('company_id', fromId),
    (admin as any).from('metrics').select('slug').eq('fund_id', who.fundId).eq('company_id', intoId),
  ])
  const tracked = new Set(((intoMetrics as any[]) ?? []).map(m => m.slug))
  const movable = ((fromMetrics as any[]) ?? []).filter(m => !tracked.has(m.slug)).map(m => m.id)
  const metricsLeft = ((fromMetrics as any[]) ?? []).length - movable.length
  if (movable.length) {
    const { error: metricError } = await (admin as any).from('metrics').update({ company_id: intoId }).eq('fund_id', who.fundId).in('id', movable)
    if (metricError) warnings.push(`Metrics could not be moved: ${metricError.message}`)
    else {
      rowsMoved.metrics = movable.length
      await (admin as any).from('metric_values').update({ company_id: intoId }).eq('fund_id', who.fundId).in('metric_id', movable)
    }
  }
  if (metricsLeft) warnings.push(`${metricsLeft} metric(s) ${into.name} already tracks under the same name were not moved.`)

  // 4. Names and entities.
  const aliases: string[] = Array.isArray(into.aliases) ? [...into.aliases] : []
  for (const a of [from.name, ...(Array.isArray(from.aliases) ? from.aliases : [])]) {
    if (typeof a === 'string' && a.trim() && a.toLowerCase() !== String(into.name).toLowerCase()
      && !aliases.some(x => x.toLowerCase() === a.toLowerCase())) aliases.push(a.trim())
  }
  const groups: string[] = Array.from(new Set([
    ...(Array.isArray(into.portfolio_group) ? into.portfolio_group : []),
    ...(Array.isArray(from.portfolio_group) ? from.portfolio_group : []),
  ]))
  // Re-read: moving transactions may already have added entities.
  const { data: fresh } = await (admin as any).from('companies').select('portfolio_group').eq('id', intoId).maybeSingle()
  for (const g of (Array.isArray(fresh?.portfolio_group) ? fresh.portfolio_group : [])) if (!groups.includes(g)) groups.push(g)
  const { error: intoError } = await (admin as any).from('companies').update({ aliases, portfolio_group: groups }).eq('id', intoId).eq('fund_id', who.fundId)
  if (intoError) warnings.push(`The aliases could not be saved: ${intoError.message}`)

  // 5. The merged record.
  const removed = from.holding_type === 'fund'
    ? await deleteFundHolding(admin, who, fromId, loadScope)
    : await deleteCompany(admin, who, fromId, loadScope)
  let keptBecause: string | undefined
  if (!removed.ok) {
    keptBecause = removed.error
    await (admin as any).from('chart_of_accounts').update({ is_active: false }).eq('fund_id', who.fundId).eq('company_id', fromId)
  }

  logActivity(admin, who.fundId, who.userId, 'company.merge', { companyId: intoId, mergedId: fromId, mergedName: from.name })
  return done({
    from: { id: from.id, name: from.name },
    into: { id: into.id, name: into.name },
    transactionsMoved,
    registerRowsMoved,
    termsDropped,
    rowsMoved,
    aliases,
    deleted: removed.ok,
    ...(keptBecause ? { keptBecause } : {}),
    warnings,
  })
}
