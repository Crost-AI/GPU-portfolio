import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; resolveGroupOr400 checks BOTH entities of an invoice, so a manco
// side still needs the management-company grant.
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName, vehicleNameById } from '@/lib/accounting/vehicle-id'
import { listVehiclesWithId } from '@/lib/accounting/load'
import { previousQuarter } from '@/lib/accounting/receipts-core'
import { ensureIntercompanyAccounts, intercompanyChart, linkIntercompanyAccount } from '@/lib/accounting/intercompany'
import {
  previewPartnershipInvoice, createPartnershipInvoice, issuePartnershipInvoice, voidPartnershipInvoice, deletePartnershipInvoice, editPartnershipInvoice, addableInvoiceLines,
  listPartnershipInvoices, unbilledByCounterparty, getPartnershipInvoice, receivableCandidates,
} from '@/lib/accounting/partnership-invoices'

type Gate = Exclude<Awaited<ReturnType<typeof assertReadAccess>>, NextResponse>

/** The billed entity, by id, checked the same way as the billing one. */
async function counterparty(admin: ReturnType<typeof createAdminClient>, gate: Gate, id: unknown): Promise<{ vehicleId: string; name: string } | NextResponse> {
  const vehicleId = typeof id === 'string' ? id : ''
  const name = vehicleId ? await vehicleNameById(admin, gate.fundId, vehicleId) : null
  if (!name) return NextResponse.json({ error: 'The entity to bill is not in this fund.' }, { status: 400 })
  const ok = await resolveGroupOr400(admin, gate, name)
  if (ok instanceof NextResponse) return ok
  return { vehicleId, name }
}

/**
 * GET ?group=<billing entity>
 *   → { invoices, unbilled, counterparties, receivableAccounts, defaultQuarter }
 * GET ?group=…&to=<entity id>&year=2026&quarter=3[&from=YYYY-MM-DD][&through=YYYY-MM-DD]
 *   → the preview: what an invoice for that quarter would bill, read from the expenses dated in the
 *     range (default: every unbilled one through the quarter's end)
 * GET ?group=…&id=<invoice id>
 *   → one invoice with its lines, and for a draft the biller sent, `addable`: the unbilled expenses
 *     it could still pick up
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const sp = req.nextUrl.searchParams
  const group = await resolveGroupOr400(admin, gate, sp.get('group'))
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  if (!vehicleId) return NextResponse.json({ error: `Unknown vehicle "${group}".` }, { status: 400 })

  const id = sp.get('id')
  if (id) {
    const inv = await getPartnershipInvoice(admin, gate.fundId, id)
    if (!inv || (inv.from.vehicleId !== vehicleId && inv.to.vehicleId !== vehicleId)) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    const other = await counterparty(admin, gate, inv.from.vehicleId === vehicleId ? inv.to.vehicleId : inv.from.vehicleId)
    if (other instanceof NextResponse) return other
    // A draft the billing entity is editing also gets the expenses it could still add.
    return NextResponse.json({ invoice: inv, addable: inv.from.vehicleId === vehicleId ? await addableInvoiceLines(admin, gate.fundId, inv) : [] })
  }

  if (sp.get('to')) {
    const to = await counterparty(admin, gate, sp.get('to'))
    if (to instanceof NextResponse) return to
    const preview = await previewPartnershipInvoice(admin, gate.fundId, {
      fromVehicleId: vehicleId, toVehicleId: to.vehicleId, year: Number(sp.get('year')), quarter: Number(sp.get('quarter')),
      from: sp.get('from') || null, through: sp.get('through') || null,
    })
    if ('error' in preview) return NextResponse.json({ error: preview.error }, { status: 400 })
    return NextResponse.json({ preview })
  }

  const [invoices, unbilled, vehicles, chart] = await Promise.all([
    listPartnershipInvoices(admin, gate.fundId, vehicleId),
    unbilledByCounterparty(admin, gate.fundId, vehicleId),
    listVehiclesWithId(admin, gate.fundId),
    intercompanyChart(admin, gate.fundId, vehicleId),
  ])
  const names = new Map(vehicles.map(v => [v.id, v.name]))
  return NextResponse.json({
    vehicleId,
    invoices: invoices.map(i => ({ ...i, from_name: names.get(i.from_vehicle_id) ?? null, to_name: names.get(i.to_vehicle_id) ?? null })),
    unbilled,
    // Who this entity can bill: every other fund vehicle (a manco is not billed for fund expenses).
    counterparties: vehicles.filter(v => v.id && v.id !== vehicleId),
    // The accounts that could be a fund's "Due from", each with the entity it is linked to.
    receivableAccounts: receivableCandidates(chart),
    defaultQuarter: previousQuarter(new Date().toISOString().slice(0, 10)),
  })
}

/**
 * POST
 *   { group, action: 'create', to, year, quarter, invoiceDate?, memo?, exclude? }  freeze the quarter into a
 *        draft; exclude lists posting ids to leave off (they stay open for the next invoice),
 *        allocations { postingId: basis } replaces a line's allocation basis, and remember lists the
 *        lines whose basis is saved for that vendor's future expenses billed to the fund, and
 *        adjustments [{ description, amount }] are credits (negative) or charges (positive) printed
 *        below the expenses that change the amount due, not the amount booked
 *   { group, action: 'issue', id }   book the fund's side (Dr partnership expenses, Cr due to <group>)
 *   { group, action: 'delete', id }  delete a draft and release its lines
 *   { group, action: 'void', id }    void an issued invoice and release its lines; the fund's entry is voided first
 *   { group, action: 'accounts', to } add "Due from <to>" (and "Due to <to>") to group's chart
 *   { group, action: 'link', to, accountId } make an existing account of group's "Due from <to>"
 *   { group, action: 'edit', id, allocations?, remember?, descriptions?, add?, remove? }
 *     allocations { postingId: basis } and descriptions { postingId: { vendor?, description? } }
 *     work on a draft or an issued invoice (descriptions are written to the expense's journal
 *     entry); add and remove (posting ids) change a draft's expenses and its amount;
 *     addAdjustments [{ description, amount }] and removeAdjustments (ids) change a draft's
 *     adjustments and its amount due
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group)
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  if (!vehicleId) return NextResponse.json({ error: `Unknown vehicle "${group}".` }, { status: 400 })

  if (body?.action === 'create') {
    const to = await counterparty(admin, gate, body?.to)
    if (to instanceof NextResponse) return to
    const res = await createPartnershipInvoice(admin, gate.fundId, user.id, {
      fromVehicleId: vehicleId, toVehicleId: to.vehicleId,
      year: Number(body?.year), quarter: Number(body?.quarter),
      invoiceDate: typeof body?.invoiceDate === 'string' ? body.invoiceDate : null,
      from: typeof body?.from === 'string' && body.from ? body.from : null,
      through: typeof body?.through === 'string' && body.through ? body.through : null,
      memo: typeof body?.memo === 'string' ? body.memo : null,
      allocations: body?.allocations && typeof body.allocations === 'object' && !Array.isArray(body.allocations)
        ? Object.fromEntries(Object.entries(body.allocations).filter(([, v]) => typeof v === 'string')) as Record<string, string>
        : null,
      rememberPostingIds: Array.isArray(body?.remember) ? body.remember.filter((x: unknown): x is string => typeof x === 'string') : null,
      excludePostingIds: Array.isArray(body?.exclude) ? body.exclude.filter((x: unknown): x is string => typeof x === 'string') : null,
      adjustments: Array.isArray(body?.adjustments) ? body.adjustments : null,
    })
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: res.status ?? 400 })
    return NextResponse.json({ ok: true, ...res })
  }

  if (body?.action === 'issue' || body?.action === 'void' || body?.action === 'delete') {
    const id = String(body?.id ?? '')
    const inv = await getPartnershipInvoice(admin, gate.fundId, id)
    // Only the billing entity issues, voids or deletes its own invoices.
    if (!inv || inv.from.vehicleId !== vehicleId) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    const to = await counterparty(admin, gate, inv.to.vehicleId)
    if (to instanceof NextResponse) return to
    const res = body.action === 'issue'
      ? await issuePartnershipInvoice(admin, gate.fundId, user.id, id)
      : body.action === 'delete'
        ? await deletePartnershipInvoice(admin, gate.fundId, id)
        : await voidPartnershipInvoice(admin, gate.fundId, id)
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: res.status ?? 400 })
    return NextResponse.json(res)
  }

  if (body?.action === 'edit' || body?.action === 'bases') {
    const id = String(body?.id ?? '')
    const inv = await getPartnershipInvoice(admin, gate.fundId, id)
    // As with issue and void: only the billing entity edits its own invoices.
    if (!inv || inv.from.vehicleId !== vehicleId) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    const to = await counterparty(admin, gate, inv.to.vehicleId)
    if (to instanceof NextResponse) return to
    const ids = (v: unknown) => Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === 'string') : null
    const record = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
    const res = await editPartnershipInvoice(admin, gate.fundId, user.id, id, {
      allocations: Object.fromEntries(Object.entries(record(body?.allocations)).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
      rememberPostingIds: ids(body?.remember),
      addPostingIds: ids(body?.add),
      removePostingIds: ids(body?.remove ?? body?.release),
      addAdjustments: Array.isArray(body?.addAdjustments) ? body.addAdjustments : null,
      removeAdjustmentIds: ids(body?.removeAdjustments),
      descriptions: Object.fromEntries(Object.entries(record(body?.descriptions)).map(([k, v]) => {
        const d = record(v)
        return [k, { vendor: typeof d.vendor === 'string' ? d.vendor : undefined, description: typeof d.description === 'string' ? d.description : undefined }]
      })),
    })
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: res.status ?? 400 })
    return NextResponse.json(res)
  }

  if (body?.action === 'accounts') {
    const to = await counterparty(admin, gate, body?.to)
    if (to instanceof NextResponse) return to
    if (to.vehicleId === vehicleId) return NextResponse.json({ error: 'An entity cannot bill itself.' }, { status: 400 })
    try {
      const ids = await ensureIntercompanyAccounts(admin, gate.fundId, group, to)
      return NextResponse.json({ ok: true, receivableAccountId: ids.receivableAccountId })
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 })
    }
  }

  if (body?.action === 'link') {
    const to = await counterparty(admin, gate, body?.to)
    if (to instanceof NextResponse) return to
    const accountId = typeof body?.accountId === 'string' ? body.accountId : ''
    const chart = await intercompanyChart(admin, gate.fundId, vehicleId)
    if (!receivableCandidates(chart).some(a => a.id === accountId)) {
      return NextResponse.json({ error: 'Choose one of this entity’s receivable accounts.' }, { status: 400 })
    }
    const res = await linkIntercompanyAccount(admin, gate.fundId, vehicleId, accountId, to.vehicleId, 'receivable')
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: 409 })
    return NextResponse.json(res)
  }

  return NextResponse.json({ error: 'action must be create, issue, delete, void, edit, accounts or link' }, { status: 400 })
}
