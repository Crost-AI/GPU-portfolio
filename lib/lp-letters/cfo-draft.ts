// The quarterly LP letter, CFO draft: gathering its sources and saving it as a draft.
//
// Sources are the entity's portfolio as the letter generator sees it (aggregate.ts) plus the
// companies' stored updates for the quarter (company_updates). Nothing about the fund's investors
// is read except their names, and only so they can be kept out (cfo-brief.ts).
//
// A draft is always a NEW letter, status draft, shared with no one: drafting never overwrites a
// letter someone has edited, completed or shared. Review, editing and sharing are the LP Letters
// page's (or lp_write_letter / lp_share_letter's), as for any other letter.

import type { SupabaseClient } from '@supabase/supabase-js'
import { aggregatePortfolioData, type PortfolioPreview } from './aggregate'
import { buildPortfolioTableHtml } from './generate'
import { createLetter } from './service'
import { sanitizeLetterHtml } from '@/lib/sanitize'
import { done, dbFail, type Outcome } from '@/lib/service-outcome'
import { createFundAIProvider } from '@/lib/ai'
import { logAIUsage } from '@/lib/ai/usage'
import {
  CFO_DRAFT_LABEL, briefAsPrompt, buildLetterBrief, quarterBounds,
  type LetterBrief, type StoredUpdate,
} from './cfo-brief'

type Admin = SupabaseClient

export interface LetterPeriod {
  vehicle: string
  year: number
  quarter: number
  yearEnd?: boolean
}

/** Updates arriving this long after quarter end, with no period of their own, count as the quarter's. */
const LATE_REPORTING_DAYS = 60

function updateInQuarter(u: any, year: number, quarter: number): boolean {
  if (u.period_year != null) {
    if (Number(u.period_year) !== year) return false
    if (u.period_quarter != null) return Number(u.period_quarter) === quarter
    if (u.period_month != null) return Math.ceil(Number(u.period_month) / 3) === quarter
    return false
  }
  const { start, end } = quarterBounds(year, quarter)
  const late = new Date(`${end}T00:00:00Z`)
  late.setUTCDate(late.getUTCDate() + LATE_REPORTING_DAYS)
  const received = String(u.received_at ?? '').slice(0, 10)
  return received >= start && received <= late.toISOString().slice(0, 10)
}

/** The quarter's stored updates per company, newest first, three at most. Sender details are not read. */
export async function quarterUpdates(admin: Admin, fundId: string, companyIds: string[], year: number, quarter: number): Promise<Map<string, StoredUpdate[]>> {
  const out = new Map<string, StoredUpdate[]>()
  if (!companyIds.length) return out
  const { data } = await (admin as any)
    .from('company_updates')
    .select('company_id, received_at, subject, period_label, period_year, period_quarter, period_month, body_current, body_original')
    .eq('fund_id', fundId)
    .in('company_id', companyIds)
    .order('received_at', { ascending: false })
    .limit(500)
  for (const u of (data ?? []) as any[]) {
    if (!updateInQuarter(u, year, quarter)) continue
    const text = String(u.body_current ?? u.body_original ?? '').trim()
    if (!text) continue
    const list = out.get(u.company_id) ?? []
    if (list.length < 3) list.push({ receivedAt: String(u.received_at), subject: u.subject ?? null, periodLabel: u.period_label ?? null, text })
    out.set(u.company_id, list)
  }
  return out
}

async function investorNames(admin: Admin, fundId: string): Promise<string[]> {
  const { data } = await (admin as any).from('lp_investors').select('name').eq('fund_id', fundId)
  return ((data ?? []) as any[]).map(r => String(r.name ?? '')).filter(Boolean)
}

export interface LoadedBrief {
  brief: LetterBrief
  preview: PortfolioPreview
  investorNames: string[]
}

export async function loadLetterBrief(admin: Admin, fundId: string, p: LetterPeriod): Promise<LoadedBrief> {
  const preview = await aggregatePortfolioData(admin as any, fundId, p.year, p.quarter, p.vehicle, !!p.yearEnd)
  const ids = preview.companies.map(c => c.investment.companyId)
  const [updates, names] = await Promise.all([
    quarterUpdates(admin, fundId, ids, p.year, p.quarter),
    investorNames(admin, fundId),
  ])
  return { brief: buildLetterBrief({ preview, year: p.year, quarter: p.quarter, updates, investorNames: names }), preview, investorNames: names }
}

/** The fund's own AI provider writes the letter from the brief, in one call. */
export async function writeWithFundAI(admin: Admin, fundId: string, userId: string | null, brief: LetterBrief): Promise<string> {
  const { provider, model, providerType } = await createFundAIProvider(admin as any, fundId)
  const result = await provider.createMessage({
    model,
    maxTokens: 4000,
    system:
      'You are the CFO of a venture fund writing to its limited partners. You write plainly and precisely, state bad news ' +
      'directly, and never add a number or claim your sources do not contain. Plain text, no markdown.',
    content: briefAsPrompt(brief),
  })
  await logAIUsage(admin as any, {
    fundId, userId: userId ?? undefined, provider: providerType, model, feature: 'lp-letter-cfo-draft', usage: result.usage,
  })
  return result.text.trim()
}

/**
 * Save a CFO draft as a new letter: status draft, shared with no one. The portfolio table and
 * summary come from the books, as for a generated letter, so the PDF and export carry the same
 * figures the draft was written from.
 */
export async function saveCfoDraft(
  admin: Admin, ctx: { fundId: string; userId: string; visible: string[] | null },
  p: LetterPeriod, text: string, preview: PortfolioPreview,
): Promise<Outcome<any>> {
  const created = await createLetter(admin, ctx, {
    period_year: p.year, period_quarter: p.quarter, portfolio_group: p.vehicle, is_year_end: !!p.yearEnd,
    generation_prompt: CFO_DRAFT_LABEL,
  })
  if (!created.ok) return created
  const { data, error } = await (admin as any)
    .from('lp_letters')
    .update({
      full_draft: text,
      portfolio_table_html: sanitizeLetterHtml(buildPortfolioTableHtml(preview)) ?? '',
      portfolio_summary: preview.companies.map(c => ({
        company_id: c.investment.companyId, company_name: c.investment.companyName, status: c.investment.status,
        stage: c.investment.stage, total_invested: c.investment.totalInvested, fmv: c.investment.fmv, moic: c.investment.moic,
      })),
      status: 'draft',
      updated_at: new Date().toISOString(),
    })
    .eq('id', created.value.id).eq('fund_id', ctx.fundId).select().single()
  if (error) return dbFail(error, 'lp-letters-cfo-draft')
  return done(data)
}
