import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parseChecklistText } from '@/lib/diligence/parse-checklist'
import { dbError } from '@/lib/api-error'
import { addChecklistItem, updateChecklistItem } from '@/lib/diligence/service'
import { outcomeResponse } from '@/lib/service-outcome'

interface ChecklistRow {
  id: string
  deal_id: string
  parent_id: string | null
  kind: 'section' | 'item'
  label: string
  status: 'unknown' | 'found' | 'partial' | 'missing' | 'not_applicable'
  evidence: Array<{ document_id?: string; summary?: string }>
  agent_notes: string | null
  partner_notes: string | null
  partner_facts: Array<{ id: string; text: string }>
  order_index: number
  source: 'template' | 'partner_added' | 'imported' | 'agent_added'
  created_at: string
  updated_at: string
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const guard = await ensureMember()
  if ('error' in guard) return guard.error
  const { admin, fundId } = guard

  const { data, error } = await (admin as any)
    .from('diligence_checklist_items')
    .select('*')
    .eq('deal_id', params.id)
    .eq('fund_id', fundId)
    .order('order_index', { ascending: true })

  if (error) return dbError(error, 'diligence-checklist-list')
  return NextResponse.json({ items: (data ?? []) as unknown as ChecklistRow[] })
}

/**
 * POST — apply a checklist. Two modes:
 *   { mode: 'replace', text }  → parse text + replace all existing items.
 *   { mode: 'add', label, sectionLabel? }  → append a single partner-added item.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const guard = await ensureMember()
  if ('error' in guard) return guard.error
  const { admin, fundId } = guard

  const { data: deal } = await (admin as any)
    .from('diligence_deals')
    .select('id')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!deal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))

  // mode === 'reorder' — persist a new order for a set of sibling items.
  // The client sends the item ids in their new order; we reassign their own
  // existing order_index values (a permutation), so the items stay within
  // their current range and no other rows collide.
  if (body.mode === 'reorder') {
    const itemIds: string[] = Array.isArray(body.itemIds)
      ? body.itemIds.filter((x: unknown): x is string => typeof x === 'string')
      : []
    if (itemIds.length === 0) return NextResponse.json({ error: 'itemIds is required' }, { status: 400 })

    const { data: rows, error: fetchErr } = await (admin as any)
      .from('diligence_checklist_items')
      .select('id, order_index')
      .eq('deal_id', params.id)
      .eq('fund_id', fundId)
      .in('id', itemIds)
    if (fetchErr) return dbError(fetchErr, 'diligence-checklist-reorder-fetch')
    const found = (rows ?? []) as Array<{ id: string; order_index: number }>
    if (found.length !== itemIds.length) {
      return NextResponse.json({ error: 'Some items were not found on this deal' }, { status: 400 })
    }

    const slots = found.map(r => r.order_index).sort((a, b) => a - b)
    const now = new Date().toISOString()
    for (let i = 0; i < itemIds.length; i++) {
      const { error: updErr } = await (admin as any)
        .from('diligence_checklist_items')
        .update({ order_index: slots[i], updated_at: now })
        .eq('id', itemIds[i])
        .eq('deal_id', params.id)
        .eq('fund_id', fundId)
      if (updErr) return dbError(updErr, 'diligence-checklist-reorder-update')
    }
    return NextResponse.json({ ok: true })
  }

  const mode = body.mode === 'add' || body.mode === 'add_section' ? body.mode : 'replace'

  if (mode === 'add_section') {
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    if (!label) return NextResponse.json({ error: 'label is required' }, { status: 400 })

    let maxOrder = 0
    const { data: rows } = await (admin as any)
      .from('diligence_checklist_items')
      .select('order_index')
      .eq('deal_id', params.id)
      .eq('fund_id', fundId)
    for (const r of ((rows ?? []) as Array<{ order_index: number }>)) {
      if (r.order_index > maxOrder) maxOrder = r.order_index
    }

    const { data: section, error: secErr } = await (admin as any)
      .from('diligence_checklist_items')
      .insert({
        deal_id: params.id,
        fund_id: fundId,
        parent_id: null,
        kind: 'section',
        label,
        order_index: maxOrder + 1,
        source: 'partner_added',
      })
      .select('*')
      .single()
    if (secErr) return dbError(secErr, 'diligence-checklist-add-section')
    return NextResponse.json({ item: section })
  }

  if (mode === 'add') {
    return outcomeResponse(
      await addChecklistItem(admin, fundId, params.id, { label: body.label, sectionLabel: body.sectionLabel }),
      item => ({ item }),
    )
  }

  // mode === 'replace'
  const text = typeof body.text === 'string' ? body.text : ''
  const parsed = parseChecklistText(text)
  if (parsed.length === 0) return NextResponse.json({ error: 'No checklist content found' }, { status: 400 })

  // Wipe existing rows for this deal — partner is replacing the whole checklist.
  const { error: delErr } = await (admin as any)
    .from('diligence_checklist_items')
    .delete()
    .eq('deal_id', params.id)
    .eq('fund_id', fundId)
  if (delErr) return dbError(delErr, 'diligence-checklist-replace-delete')

  // Sections first so we can resolve parent_id for items.
  const sectionIdByLabel: Record<string, string> = {}
  let order = 0
  for (const entry of parsed) {
    if (entry.kind !== 'section') continue
    order += 1
    const { data: sec, error: secErr } = await (admin as any)
      .from('diligence_checklist_items')
      .insert({
        deal_id: params.id,
        fund_id: fundId,
        parent_id: null,
        kind: 'section',
        label: entry.label,
        order_index: order,
        source: 'template',
      } as any)
      .select('id')
      .single()
    if (secErr) return dbError(secErr, 'diligence-checklist-replace-section')
    sectionIdByLabel[entry.label] = (sec as any).id as string
  }

  // Items, batched in chunks of 100 to avoid huge single requests.
  const itemRows = parsed
    .filter(e => e.kind === 'item')
    .map(e => {
      order += 1
      return {
        deal_id: params.id,
        fund_id: fundId,
        parent_id: sectionIdByLabel[(e as Extract<typeof e, { kind: 'item' }>).sectionLabel] ?? null,
        kind: 'item',
        label: e.label,
        order_index: order,
        source: 'template',
      }
    })

  for (let i = 0; i < itemRows.length; i += 100) {
    const chunk = itemRows.slice(i, i + 100)
    const { error: insErr } = await (admin as any)
      .from('diligence_checklist_items')
      .insert(chunk as any)
    if (insErr) return dbError(insErr, 'diligence-checklist-replace-items')
  }

  const { data: items } = await (admin as any)
    .from('diligence_checklist_items')
    .select('*')
    .eq('deal_id', params.id)
    .eq('fund_id', fundId)
    .order('order_index', { ascending: true })
  return NextResponse.json({ items: items ?? [] })
}

/**
 * PATCH — partial update to a single checklist item.
 *   { itemId, label? | status? | agent_notes? | not_applicable? }
 */
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const guard = await ensureMember()
  if ('error' in guard) return guard.error
  const { admin, fundId } = guard

  const body = await req.json().catch(() => ({}))
  const itemId = typeof body.itemId === 'string' ? body.itemId : ''
  if (!itemId) return NextResponse.json({ error: 'itemId is required' }, { status: 400 })

  const result = await updateChecklistItem(admin, fundId, params.id, itemId, {
    label: body.label,
    status: body.status,
    agentNotes: body.agent_notes,
    partnerNotes: body.partner_notes,
    partnerFacts: body.partner_facts,
  })
  return outcomeResponse(result, item => ({ item }))
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const guard = await ensureMember()
  if ('error' in guard) return guard.error
  const { admin, fundId } = guard

  const url = new URL(req.url)
  const itemId = url.searchParams.get('itemId')
  if (!itemId) return NextResponse.json({ error: 'itemId is required' }, { status: 400 })

  const { error } = await (admin as any)
    .from('diligence_checklist_items')
    .delete()
    .eq('id', itemId)
    .eq('deal_id', params.id)
    .eq('fund_id', fundId)
  if (error) return dbError(error, 'diligence-checklist-item-delete')
  return NextResponse.json({ ok: true })
}

async function ensureMember() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = createAdminClient()
  const { data: membership } = await (admin as any)
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return { error: NextResponse.json({ error: 'No fund found' }, { status: 403 }) }
  return { admin, fundId: (membership as any).fund_id as string, userId: user.id }
}
