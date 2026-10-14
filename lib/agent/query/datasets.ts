// The query tools' loaders (catalog.ts names the datasets). Each loads its rows through the handler
// a named tool already uses, so the same entity scope, the same carry folding and the same figures;
// the query handler has checked that tool's access before calling it.
//
// INVARIANT: every loader returns the WHOLE authorized set, never a page of it. The engine filters
// and aggregates in memory, so a capped source turns `count` and `sum` into confident wrong answers
// with `truncated: false`. A named tool that caps its list (deals_list_inbound's newest 500) or reads
// unpaged (PostgREST's 1000-row max_rows) cannot be a loader's source; those datasets read here,
// paged with fetchAllRows in a stable order, through the SAME scope helpers their tool applies.

import type { AgentToolContext } from '@/lib/accounting/agent-tools'
import { scopeCompanyRows, scopeTransactions, visibleCompanyIds, visibleVehicleIds } from '@/lib/access/scope'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { carryRecipientIds, seesIndividualCarry } from '@/lib/access/carry-visibility'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { fetchAllRows } from '@/lib/accounting/load'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { PORTFOLIO_HANDLERS } from '@/lib/agent/portfolio-tools'
import { LP_HANDLERS } from '@/lib/agent/lp-tools'

export interface DatasetParams { vehicle?: string; as_of?: string }
type Loader = (ctx: AgentToolContext, params: DatasetParams) => Promise<Record<string, unknown>[]>

type Row = Record<string, unknown>
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v))
const date = (v: unknown) => (v ? String(v).slice(0, 10) : null)

// ---------------------------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------------------------

const positions: Loader = async (ctx, p) => {
  const out = await PORTFOLIO_HANDLERS.portfolio_summary(ctx, { vehicle: p.vehicle, as_of: p.as_of })
  return (out.positions as any[]).map(r => ({
    company: r.company, company_id: r.companyId, status: r.status, stage: r.stage, industry: r.industry ?? [],
    invested: r.invested, cost: r.cost, fair_value: r.fairValue, unrealized: r.unrealized, realized: r.realized,
    moic: r.moic, pct_of_portfolio: r.pctOfPortfolio,
  }))
}

const companies: Loader = async (ctx, p) => {
  const rows = await PORTFOLIO_HANDLERS.list_companies(ctx, { vehicle: p.vehicle }) as any[]
  return rows.map(c => ({ company: c.name, company_id: c.id, status: c.status, stage: c.stage, industry: c.industry ?? [], vehicles: c.vehicles ?? [] }))
}

// list_investments' read and scope, paged: unpaged, it stopped at 1000 transactions.
const transactions: Loader = async (ctx, p) => {
  const db = ctx.admin as any
  const scope = await entityScopeFor(ctx.admin, ctx.access)
  const [txns, cos] = await Promise.all([
    fetchAllRows<any>((f, t) => {
      let q = db.from('investment_transactions').select('*').eq('fund_id', ctx.fundId)
      if (p.vehicle) q = q.eq('portfolio_group', p.vehicle)
      return q.order('transaction_date', { ascending: true }).order('id').range(f, t)
    }),
    // Names from list_companies' set: the caller's companies, holding_type 'company'.
    fetchAllRows<any>((f, t) => db.from('companies').select('id, name').eq('fund_id', ctx.fundId).eq('holding_type', 'company').order('id').range(f, t)),
  ])
  // Only the caller's companies and entities.
  const rows = scopeTransactions(scopeCompanyRows(txns, scope.companyIds, 'company_id'), scope.vehicleNames)
  const names = new Map(scopeCompanyRows(cos, scope.companyIds).map(c => [c.id, c.name]))
  return rows.map(t => ({
    date: date(t.transaction_date), company: names.get(t.company_id) ?? null, company_id: t.company_id, vehicle: t.portfolio_group ?? null,
    type: t.transaction_type, round: t.round_name ?? null, security: t.security_type ?? null,
    invested: num(t.investment_cost), shares: num(t.shares_acquired), share_price: num(t.share_price),
    postmoney: num(t.postmoney_valuation), proceeds: num(t.proceeds_received), ownership_pct: num(t.ownership_pct),
  }))
}

const kpis: Loader = async (ctx) => {
  const db = ctx.admin as any
  const visible = await visibleCompanyIds(ctx.admin, ctx.access)
  let q = db.from('companies').select('id, name').eq('fund_id', ctx.fundId).eq('holding_type', 'company')
  if (visible !== null) q = q.in('id', visible.length ? visible : ['00000000-0000-0000-0000-000000000000'])
  const { data: cos } = await q
  const names = new Map(((cos ?? []) as any[]).map(c => [c.id, c.name]))
  if (names.size === 0) return []
  const metrics = await fetchAllRows<any>((f, t) => db.from('metrics').select('id, name, unit, company_id').in('company_id', [...names.keys()]).range(f, t))
  const byId = new Map(metrics.map(m => [m.id, m]))
  if (byId.size === 0) return []
  const values: any[] = []
  const ids = [...byId.keys()]
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    values.push(...await fetchAllRows<any>((f, t) => db.from('metric_values')
      .select('metric_id, period_label, period_year, period_quarter, period_month, value_number, value_text').in('metric_id', chunk).range(f, t)))
  }
  return values.map(v => {
    const m = byId.get(v.metric_id)
    return {
      company: names.get(m.company_id) ?? null, company_id: m.company_id, metric: m.name, unit: m.unit ?? null,
      period: v.period_label, year: num(v.period_year), quarter: num(v.period_quarter), month: num(v.period_month),
      value: num(v.value_number), value_text: v.value_text ?? null,
    }
  })
}

// ---------------------------------------------------------------------------------------------
// LPs
// ---------------------------------------------------------------------------------------------

const lpPositions: Loader = async (ctx, p) => {
  const out = await LP_HANDLERS.lp_live_report(ctx, { vehicle: p.vehicle, as_of: p.as_of })
  return (out.rows as any[]).map(r => ({
    investor: r.investor, entity: r.entity, vehicle: r.vehicle,
    commitment: r.commitment, called_capital: r.called_capital, paid_in_capital: r.paid_in_capital,
    unfunded: Math.round((r.commitment - r.called_capital) * 100) / 100,
    distributions: r.distributions, nav: r.nav, total_value: r.total_value,
    dpi: r.dpi, rvpi: r.rvpi, tvpi: r.tvpi, irr: r.irr,
    paid_in_pct: r.commitment > 0 ? Math.round((r.paid_in_capital / r.commitment) * 10000) / 100 : null,
  }))
}

const capitalCallLines: Loader = async (ctx, p) => {
  const out = await LP_HANDLERS.lp_capital_calls(ctx, { vehicle: p.vehicle })
  return (out.calls as any[]).flatMap(c => (c.lines as any[]).map(l => ({
    vehicle: out.vehicle, call_number: c.number, call_date: date(c.date), due_date: date(c.due_date),
    lp: l.lp, amount: l.amount, funded: l.funded, outstanding: l.outstanding, status: l.status,
    overdue: !!l.overdue, funded_on: date(l.funded_on), says_wired: !!l.says_wired,
  })))
}

// ---------------------------------------------------------------------------------------------
// Deals and diligence
// ---------------------------------------------------------------------------------------------

// deals_list_inbound's read and scope, without its newest-500 cap.
const inboundDeals: Loader = async (ctx) => {
  // The caller's entities only (filtered for a scoped caller).
  const vehicleIds = visibleVehicleIds(ctx.access)
  const rows = await fetchAllRows<any>((f, t) => {
    let q = (ctx.admin as any).from('inbound_deals')
      .select('id, company_name, founder_name, intro_source, referrer_name, thesis_fit_score, stage, industry, raise_amount, status, promoted_diligence_id, created_at')
      .eq('fund_id', ctx.fundId)
    if (vehicleIds !== null) q = q.in('vehicle_id', vehicleIds)
    return q.order('created_at', { ascending: false }).order('id').range(f, t)
  })
  return rows.map(d => ({
    company: d.company_name, founder: d.founder_name, intro_source: d.intro_source, referrer: d.referrer_name, thesis_fit: d.thesis_fit_score,
    stage: d.stage, industry: d.industry, raise: d.raise_amount, status: d.status, in_diligence: !!d.promoted_diligence_id, created_at: date(d.created_at),
  }))
}

// diligence_list_deals' read and scope, paged: unpaged, it stopped at 1000 deals.
const diligenceDeals: Loader = async (ctx) => {
  const vehicleIds = visibleVehicleIds(ctx.access)
  const rows = await fetchAllRows<any>((f, t) => {
    let q = (ctx.admin as any).from('diligence_deals')
      .select('id, name, sector, stage_at_consideration, deal_status, current_memo_stage, created_at')
      .eq('fund_id', ctx.fundId)
    if (vehicleIds !== null) q = q.in('vehicle_id', vehicleIds)
    return q.order('created_at', { ascending: false }).order('id').range(f, t)
  })
  return rows.map(d => ({ name: d.name, sector: d.sector, stage: d.stage_at_consideration, status: d.deal_status, memo_stage: d.current_memo_stage, created_at: date(d.created_at) }))
}

// ---------------------------------------------------------------------------------------------
// The books
// ---------------------------------------------------------------------------------------------

const journalLines: Loader = async (ctx, p) => {
  const db = ctx.admin as any
  const group = ctx.portfolioGroup
  const vehicleId = await vehicleIdByName(ctx.admin, ctx.fundId, group)
  if (!vehicleId) throw new Error(`Unknown vehicle "${group}"`)
  const [accounts, entries, postings, ents] = await Promise.all([
    fetchAllRows<any>((f, t) => db.from('chart_of_accounts').select('id, code, name, type').eq('fund_id', ctx.fundId).eq('vehicle_id', vehicleId).range(f, t)),
    fetchAllRows<any>((f, t) => {
      let q = db.from('journal_entries').select('id, entry_date, memo, source_type').eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('vehicle_id', vehicleId).eq('status', 'posted')
      if (p.as_of) q = q.lte('entry_date', p.as_of)
      return q.range(f, t)
    }),
    fetchAllRows<any>((f, t) => db.from('journal_postings').select('journal_entry_id, account_id, amount, lp_entity_id').eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('vehicle_id', vehicleId).range(f, t)),
    db.from('lp_entities').select('id, entity_name').eq('fund_id', ctx.fundId),
  ])
  // What each carry recipient earns is GP economics, as on capital_accounts.
  const hidden = seesIndividualCarry(ctx.access) ? new Set<string>() : await carryRecipientIds(ctx.admin, ctx.fundId, group)
  const acct = new Map(accounts.map(a => [a.id, a]))
  const entry = new Map(entries.map(e => [e.id, e]))
  const entName = new Map(((ents.data ?? []) as any[]).map(e => [e.id, e.entity_name]))
  const rows: Row[] = []
  for (const pst of postings) {
    const e = entry.get(pst.journal_entry_id)
    if (!e) continue
    const a = acct.get(pst.account_id)
    const amount = Number(pst.amount)
    rows.push({
      date: date(e.entry_date), entry_id: e.id, memo: e.memo ?? null, source: e.source_type ?? null,
      account_code: a?.code ?? null, account_name: a?.name ?? null, account_type: a?.type ?? null,
      debit: amount > 0 ? amount : 0, credit: amount < 0 ? -amount : 0, amount,
      lp: pst.lp_entity_id && !hidden.has(pst.lp_entity_id) ? entName.get(pst.lp_entity_id) ?? null : pst.lp_entity_id ? 'Carried interest recipients' : null,
    })
  }
  return rows
}

/** By dataset name (catalog.ts). */
export const QUERY_LOADERS: Record<string, Loader> = {
  positions, companies, transactions, kpis,
  lp_positions: lpPositions, capital_call_lines: capitalCallLines,
  inbound_deals: inboundDeals, diligence_deals: diligenceDeals,
  journal_lines: journalLines,
}
