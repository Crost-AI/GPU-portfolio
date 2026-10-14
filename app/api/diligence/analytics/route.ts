import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAllRows } from '@/lib/accounting/load'

export async function GET(_req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
  if ((membership as any).role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  const fundId = (membership as any).fund_id as string

  // Pull every deal + per-draft presence flags. The flags come from the diligence_memo_draft_flags
  // view, so the drafts' ingestion/research/memo JSON never leaves Postgres; both reads page past
  // the 1000-row cap so a large fund is counted in full, not silently truncated.
  type Deal = {
    id: string
    name: string
    sector: string | null
    deal_status: string
    current_memo_stage: string
    lead_partner_id: string | null
    created_at: string | null
    updated_at: string | null
  }
  type DraftFlags = {
    deal_id: string
    has_ingestion: boolean
    has_research: boolean
    qa_count: number
    has_memo_draft: boolean
    is_draft: boolean
    finalized_at: string | null
    created_at: string | null
  }
  let reads: [Deal[], DraftFlags[], { data: any[] | null }]
  try {
    reads = await Promise.all([
      fetchAllRows<Deal>((f, t) => (admin as any)
        .from('diligence_deals')
        .select('id, name, sector, deal_status, current_memo_stage, lead_partner_id, created_at, updated_at')
        .eq('fund_id', fundId)
        .order('id')
        .range(f, t)),
      fetchAllRows<DraftFlags>((f, t) => (admin as any)
        .from('diligence_memo_draft_flags')
        .select('deal_id, has_ingestion, has_research, qa_count, has_memo_draft, is_draft, finalized_at, created_at')
        .eq('fund_id', fundId)
        .order('deal_id')
        .order('id')
        .range(f, t)),
      admin
        .from('fund_members')
        .select('user_id, display_name, role')
        .eq('fund_id', fundId),
    ])
  } catch (e) {
    console.error('[diligence/analytics] read failed:', (e as { message?: string })?.message ?? e)
    return NextResponse.json({ error: 'Could not load diligence analytics' }, { status: 500 })
  }
  const [deals, drafts, { data: members }] = reads

  const memberMap = new Map<string, { display_name: string | null }>()
  for (const m of (members ?? []) as any[]) {
    memberMap.set(m.user_id, { display_name: m.display_name })
  }

  // Per-deal stage timing: earliest draft created_at, finalized_at when present.
  const draftsByDeal = new Map<string, typeof drafts>()
  for (const d of drafts) {
    if (!draftsByDeal.has(d.deal_id)) draftsByDeal.set(d.deal_id, [])
    draftsByDeal.get(d.deal_id)!.push(d)
  }

  // ---- Summary ----
  const summary = { total: 0, active: 0, passed: 0, won: 0, lost: 0, on_hold: 0 }
  for (const d of deals) {
    summary.total++
    if (d.deal_status in summary) (summary as any)[d.deal_status]++
  }

  // ---- By sector ----
  const bySector = new Map<string, { sector: string; total: number; won: number; lost: number; passed: number; active: number }>()
  for (const d of deals) {
    const k = d.sector || '(unspecified)'
    if (!bySector.has(k)) bySector.set(k, { sector: k, total: 0, won: 0, lost: 0, passed: 0, active: 0 })
    const row = bySector.get(k)!
    row.total++
    if (d.deal_status === 'won') row.won++
    else if (d.deal_status === 'lost') row.lost++
    else if (d.deal_status === 'passed') row.passed++
    else if (d.deal_status === 'active') row.active++
  }

  // ---- By partner ----
  const byPartner = new Map<string, { partner_id: string; partner_name: string | null; total: number; active: number; won: number; lost: number; passed: number }>()
  for (const d of deals) {
    const k = d.lead_partner_id || '__unassigned__'
    if (!byPartner.has(k)) {
      byPartner.set(k, {
        partner_id: k,
        partner_name: d.lead_partner_id ? (memberMap.get(d.lead_partner_id)?.display_name ?? null) : 'Unassigned',
        total: 0, active: 0, won: 0, lost: 0, passed: 0,
      })
    }
    const row = byPartner.get(k)!
    row.total++
    if (d.deal_status === 'active') row.active++
    else if (d.deal_status === 'won') row.won++
    else if (d.deal_status === 'lost') row.lost++
    else if (d.deal_status === 'passed') row.passed++
  }

  // ---- Funnel (deal count at each stage of the agent pipeline) ----
  const funnel = { created: deals.length, has_ingestion: 0, has_research: 0, has_qa: 0, has_memo_draft: 0, finalized: 0, won: 0 }
  for (const d of deals) {
    if (d.deal_status === 'won') funnel.won++
    const dDrafts = draftsByDeal.get(d.id) ?? []
    if (dDrafts.length === 0) continue
    if (dDrafts.some(x => x.has_ingestion)) funnel.has_ingestion++
    if (dDrafts.some(x => x.has_research)) funnel.has_research++
    if (dDrafts.some(x => x.qa_count > 0)) funnel.has_qa++
    if (dDrafts.some(x => x.has_memo_draft)) funnel.has_memo_draft++
    if (dDrafts.some(x => !x.is_draft && !!x.finalized_at)) funnel.finalized++
  }

  // ---- Time-in-stage ----
  const dayMs = 1000 * 60 * 60 * 24
  function median(arr: number[]): number | null {
    if (arr.length === 0) return null
    const s = [...arr].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  }

  const createdToDraft: number[] = []
  const draftToFinal: number[] = []
  for (const d of deals) {
    if (!d.created_at) continue
    const dDrafts = draftsByDeal.get(d.id) ?? []
    const earliestMemoDraft = dDrafts
      .filter(x => x.has_memo_draft && !!x.created_at)
      .map(x => new Date(x.created_at!).getTime())
      .reduce<number | null>((min, t) => min === null ? t : Math.min(min, t), null)
    if (earliestMemoDraft) {
      createdToDraft.push((earliestMemoDraft - new Date(d.created_at).getTime()) / dayMs)
    }
    const finalized = dDrafts
      .filter(x => !x.is_draft && !!x.finalized_at)
      .map(x => new Date(x.finalized_at!).getTime())
      .reduce<number | null>((max, t) => max === null ? t : Math.max(max, t), null)
    if (earliestMemoDraft && finalized) {
      draftToFinal.push((finalized - earliestMemoDraft) / dayMs)
    }
  }

  return NextResponse.json({
    summary,
    by_sector: Array.from(bySector.values()).sort((a, b) => b.total - a.total),
    by_partner: Array.from(byPartner.values()).sort((a, b) => b.total - a.total),
    funnel,
    time_in_stage: {
      median_days_created_to_draft: median(createdToDraft),
      median_days_draft_to_final: median(draftToFinal),
      sample_created_to_draft: createdToDraft.length,
      sample_draft_to_final: draftToFinal.length,
    },
  })
}
