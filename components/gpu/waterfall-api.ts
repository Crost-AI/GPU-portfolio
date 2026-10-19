// ── GPU fleet (P5) ── The Waterfall page's requests and the arithmetic it does on their replies.
// Pure: no React, no fetch of its own. The page and the tests share these builders, so a field the
// page sends is the field the test checks.

import type { DistributionPreview, DeclaredDistribution } from '@/lib/accounting/distributions'
import type { PrefLedgerRow as EngineLedgerRow } from '@/lib/gpu/waterfall'

/** A `fetch` that the page pins to its vehicle; the tests pass a fake. */
export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>

export type SendResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; code?: string }

/** One request, its JSON reply, and the route's `{ error, code }` on a refusal. Never throws. */
export async function send<T>(fetcher: Fetcher, path: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', body?: unknown): Promise<SendResult<T>> {
  let res: Response
  try {
    res = await fetcher(path, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    return { ok: false, status: 0, error: 'Could not reach the server. Check the connection and try again.' }
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: typeof data?.error === 'string' ? data.error : `The request failed (${res.status}).`,
      ...(typeof data?.code === 'string' ? { code: data.code } : {}),
    }
  }
  return { ok: true, status: res.status, data: data as T }
}

/**
 * A fetcher bound to one vehicle by name, the way `useLedgerFetch` binds the context's vehicle —
 * but from the page's own prop, so the first render cannot ask about whichever vehicle the context
 * held before this page pinned it.
 */
export function vehicleFetcher(vehicle: string, base: Fetcher = (p, i) => fetch(p, i)): Fetcher {
  return (path, init) => {
    const url = path + (path.includes('?') ? '&' : '?') + 'group=' + encodeURIComponent(vehicle)
    if (typeof init?.body !== 'string') return base(url, init)
    try {
      const b = JSON.parse(init.body)
      if (b && typeof b === 'object' && b.group === undefined) return base(url, { ...init, body: JSON.stringify({ ...b, group: vehicle }) })
    } catch { /* not JSON: send as is */ }
    return base(url, init)
  }
}

export const waterfallPaths = {
  distributions: '/api/accounting/distributions',
  prefLedger: '/api/accounting/pref-ledger',
  waterfallTerms: '/api/accounting/waterfall-terms',
  feeTerms: '/api/accounting/fee-terms',
  vehicleSettings: '/api/accounting/vehicle-settings',
}

// ── Reply shapes ───────────────────────────────────────────────────────────────────────────────

/** The distributable-cash preview: every field below is present for that kind (route header). */
export type CashPreview = DistributionPreview & {
  available: number
  reserve: number
  distributable: number
  lastReserve: number | null
  cash: NonNullable<DistributionPreview['cash']>
}

/** A row of GET /api/accounting/distributions, as this page reads it. */
export type HistoryRow = Pick<DeclaredDistribution, 'distributionId' | 'date' | 'description' | 'total' | 'lpTotal' | 'carryTotal' | 'status' | 'reserve' | 'splitMethod'> & {
  tiers: DeclaredDistribution['tiers']
  lines: { role: 'lp' | 'carry'; amount: number; settled: number }[]
}

/** A row of GET /api/accounting/pref-ledger: the engine's row, each investor named. */
export type PrefLedgerRow = Omit<EngineLedgerRow, 'perInvestor'> & {
  perInvestor?: (NonNullable<EngineLedgerRow['perInvestor']>[number] & { name: string })[]
}

export interface WaterfallTermsReply {
  terms: {
    kind: string; carryRate: number; prefRate: number
    recipients: { lpEntityId: string; pct: number }[]
    prefDayCount?: string; rocLpShare?: number
  }
  candidates: { lpEntityId: string; name: string }[]
}

export interface FeeTermsReply {
  terms: {
    basis: string; annualRate: number; frequency: string
    payeeVehicleId: string | null; effectiveFrom?: string; effectiveTo?: string | null
  } | null
}

export const CADENCES = ['monthly', 'quarterly', 'annual', 'ad_hoc'] as const
export type Cadence = (typeof CADENCES)[number]

// ── Money ──────────────────────────────────────────────────────────────────────────────────────

const toCents = (n: number) => Math.round(n * 100)
const cents = (n: number) => Math.round(n * 100) / 100

/** A typed amount: commas, spaces and a leading $ allowed; blank is null, junk is NaN. */
export function parseAmount(s: string): number | null {
  const t = s.replace(/[\s,$]/g, '')
  return t === '' ? null : Number(t)
}

// ── Preview and declare ────────────────────────────────────────────────────────────────────────

export interface ProposalInputs {
  /** YYYY-MM-DD: the preview's `asOf` and the declaration's `distributionDate`, one value. */
  date: string
  available: string
  /** Required (Karl, Q5). Pre-filled with the last declared reserve, blank on the first. */
  reserve: string
  contingencyReturn: string
  description: string
}

export type ProposalField = 'date' | 'available' | 'reserve' | 'contingencyReturn'

/** The form's opening values: today, and the reserve last declared (blank when there is none). */
export function initialInputs(lastReserve: number | null, today: string): ProposalInputs {
  return { date: today, available: '', reserve: lastReserve == null ? '' : String(lastReserve), contingencyReturn: '', description: '' }
}

export type PreviewRequest =
  | { ok: true; body: { action: 'preview'; available: number; reserve: number; contingencyReturn: number; asOf: string; method: 'waterfall' } }
  | { ok: false; field: ProposalField; error: string }

/** The preview body, or the field that stops it. Checked here so a bad reserve never leaves the page. */
export function previewRequest(inputs: ProposalInputs): PreviewRequest {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inputs.date)) return { ok: false, field: 'date', error: 'Pick the distribution date.' }
  const available = parseAmount(inputs.available)
  if (available == null || !Number.isFinite(available) || available <= 0) {
    return { ok: false, field: 'available', error: 'Enter the cash available, more than 0.' }
  }
  const reserve = parseAmount(inputs.reserve)
  if (reserve == null) return { ok: false, field: 'reserve', error: 'Enter the reserve to hold back; 0 if none.' }
  if (!Number.isFinite(reserve) || reserve < 0 || reserve >= available) {
    return { ok: false, field: 'reserve', error: 'The reserve must be at least 0 and less than the cash available.' }
  }
  const contingencyReturn = parseAmount(inputs.contingencyReturn) ?? 0
  if (!Number.isFinite(contingencyReturn) || contingencyReturn < 0 || toCents(contingencyReturn) > toCents(available) - toCents(reserve)) {
    return { ok: false, field: 'contingencyReturn', error: 'The contingency returned must be at least 0 and no more than the cash available less the reserve.' }
  }
  return {
    ok: true,
    body: { action: 'preview', available: cents(available), reserve: cents(reserve), contingencyReturn: cents(contingencyReturn), asOf: inputs.date, method: 'waterfall' },
  }
}

/**
 * The declaration body from an unmodified preview. `edited` investor amounts make it a manual
 * split, as on the capital-accounts page: no tiers, no character, nothing frozen from the
 * waterfall — but the cash and reserve still stated, so the server still holds the lines to them.
 */
export function declareRequest(args: {
  preview: CashPreview
  asOf: string
  description: string
  requestKey: string
  edits: Record<string, string> | null
}): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const { preview, asOf, requestKey, edits } = args
  const manual = edits != null
  const lines = manual
    ? preview.lines.map(l => ({ lpEntityId: l.lpEntityId, amount: cents(parseAmount(edits[l.lpEntityId] ?? String(l.amount)) ?? 0) }))
    : preview.lines.map(l => ({ lpEntityId: l.lpEntityId, amount: l.amount }))
  if (lines.some(l => !Number.isFinite(l.amount) || l.amount < 0)) return { ok: false, error: 'Each investor amount must be 0 or more.' }
  const carryLines = preview.carryLines.map(l => ({ lpEntityId: l.lpEntityId, amount: l.amount }))
  if (manual) {
    const total = lines.reduce((t, l) => t + toCents(l.amount), 0) + carryLines.reduce((t, l) => t + toCents(l.amount), 0)
    if (total !== toCents(preview.distributable)) {
      return { ok: false, error: `The lines total ${(total / 100).toFixed(2)}, but the cash available less the reserve is ${preview.distributable.toFixed(2)}. Adjust a line, or preview again.` }
    }
  }
  return {
    ok: true,
    body: {
      action: 'declare',
      requestKey,
      distributionDate: asOf,
      description: args.description.trim() || null,
      lines: lines.filter(l => l.amount > 0),
      carryLines,
      splitMethod: manual ? 'manual' : 'waterfall',
      tiers: manual ? null : preview.tiers,
      character: manual ? undefined : preview.suggestedCharacter,
      available: preview.available,
      reserve: preview.reserve,
      contingencyReturn: preview.tiers.contingencyReturn ?? 0,
      cash: manual ? undefined : preview.cash,
    },
  }
}

export const PREVIEW_AGAIN = 'The waterfall changed since you previewed; preview again.'

/** What the form does with a refusal: key on the stable code first, the message otherwise. */
export function refusal(r: { error: string; code?: string }): { text: string; field?: ProposalField; previewAgain?: boolean } {
  if (r.code === 'WATERFALL_MISMATCH' || r.code === 'STATED_CASH_MISMATCH') return { text: PREVIEW_AGAIN, previewAgain: true }
  if (r.code === 'RESERVE_REQUIRED') return { text: r.error, field: 'reserve' }
  return { text: r.error }
}

/**
 * The preview's identity, to the cent: contingency returned + preferred + return of capital +
 * profit to investors + the manager's profit share + its return-of-capital share = available − reserve.
 */
export function previewIdentity(p: Pick<CashPreview, 'tiers' | 'cash' | 'available' | 'reserve'>): { sum: number; target: number; holds: boolean } {
  const parts = [p.tiers.contingencyReturn ?? 0, p.tiers.preferred, p.tiers.returnOfCapital, p.tiers.profitToLP, p.tiers.carry, p.cash.managerRocShare]
  const sum = parts.reduce((t, n) => t + toCents(n), 0)
  const target = toCents(p.available) - toCents(p.reserve)
  return { sum: sum / 100, target: target / 100, holds: sum === target }
}

// ── The pref ledger and the position ───────────────────────────────────────────────────────────

/**
 * The ledger's column totals; the route returns rows only. Accrued and paid are flows and sum;
 * the closing carried-forward is the last row's, and (the first row bringing nothing forward)
 * equals accrued − paid.
 */
export function prefLedgerTotals(rows: PrefLedgerRow[]): { accrued: number; paid: number; carriedForward: number } {
  return {
    accrued: rows.reduce((t, r) => t + toCents(r.accrued), 0) / 100,
    paid: rows.reduce((t, r) => t + toCents(r.paid), 0) / 100,
    carriedForward: rows.length ? rows[rows.length - 1].carriedForward : 0,
  }
}

export interface PositionTiles {
  contributed: number
  capitalReturned: number
  unreturned: number
  prefPaid: number
  prefCarriedForward: number
  /** From the distributions shown, so capped like them. */
  distributedToInvestors: number
  dpi: number | null
}

/**
 * The investors' position from the pref-ledger rows (one row per event, each investor's unreturned
 * capital after it) and the history. The ledger is lifetime; `distributedToInvestors` is a sum over
 * the history shown. A contribution raises only its investor's unreturned capital and a distribution
 * only lowers it, so each rise is a contribution. Null without per-investor rows.
 */
export function positionFromLedger(rows: PrefLedgerRow[], history: Pick<HistoryRow, 'lpTotal'>[]): PositionTiles | null {
  if (rows.some(r => !r.perInvestor)) return null
  const last = new Map<string, number>()
  let contributed = 0
  for (const r of rows) {
    for (const i of r.perInvestor!) {
      const rise = toCents(i.unreturnedEnd) - toCents(last.get(i.lpEntityId) ?? 0)
      if (rise > 0) contributed += rise
      last.set(i.lpEntityId, i.unreturnedEnd)
    }
  }
  const unreturned = Array.from(last.values()).reduce((t, n) => t + toCents(n), 0)
  const distributed = history.reduce((t, h) => t + toCents(h.lpTotal), 0)
  return {
    contributed: contributed / 100,
    capitalReturned: (contributed - unreturned) / 100,
    unreturned: unreturned / 100,
    prefPaid: rows.reduce((t, r) => t + toCents(r.paid), 0) / 100,
    prefCarriedForward: rows.length ? rows[rows.length - 1].carriedForward : 0,
    distributedToInvestors: distributed / 100,
    dpi: contributed > 0 ? distributed / contributed : null,
  }
}

/** The unreturned capital alone, for the lead page: the last row's investors, summed. */
export function unreturnedCapital(rows: PrefLedgerRow[]): number | null {
  return positionFromLedger(rows, [])?.unreturned ?? null
}

// ── The history ────────────────────────────────────────────────────────────────────────────────

/**
 * The manager's profit share on one distribution: `declared` is what the carry lines say, `paid`
 * what has settled against them. A declared-but-unwired distribution is paid 0 — `carryTotal` is
 * the declared figure and must never be shown as paid.
 */
export function profitShare(row: Pick<HistoryRow, 'carryTotal' | 'lines'>): { paid: number; declared: number } {
  const carry = (row.lines ?? []).filter(l => l.role === 'carry')
  return { paid: cents(carry.reduce((t, l) => t + (l.settled ?? 0), 0)), declared: row.carryTotal }
}

/** Every distribution's profit share, summed: the cumulative tiles. */
export function profitShareTotals(rows: Pick<HistoryRow, 'carryTotal' | 'lines'>[]): { paid: number; declared: number } {
  return rows.reduce((t, r) => {
    const p = profitShare(r)
    return { paid: cents(t.paid + p.paid), declared: cents(t.declared + p.declared) }
  }, { paid: 0, declared: 0 })
}

/**
 * GET /api/accounting/distributions reads the newest 200 register rows (listDistributions
 * `.limit(200)`) and drops drafts after, so a sum over the response is a sum over what is shown,
 * never a lifetime figure.
 */
export const HISTORY_CAP = 200

/** The caption under the cumulative tiles: what they sum, and what they leave out. */
export function historyScope(n: number): { caption: string; truncated: boolean } {
  return { caption: `In the ${n} ${n === 1 ? 'distribution' : 'distributions'} shown`, truncated: n >= HISTORY_CAP }
}
