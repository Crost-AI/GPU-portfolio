// A capital call, checked before it is issued. Pure: no I/O, so every rule here is pinned by
// capital-call-check.test.ts. Whoever proposes a call (the Capital page, the API, an assistant in
// chat) gets the same answer, computed from the fund's records rather than written in prose:
//
//   * Each LP's share is their STORED commitment over the vehicle's total, split to the cent by
//     the same allocator the issue path uses. A commitment or percentage typed into the request is
//     not an input.
//   * Dates come from the request only. A missing notice or due date is listed as missing, never
//     defaulted to today or to "notice date + period".
//   * Wire instructions come from the vehicle's settings only, and fee terms from the request only
//     (the app holds no LPA fee terms). Either one absent is listed, not filled.
//   * The notice period is the LPA's, stored on the vehicle. The request may state one too; when
//     the two disagree the longer one is used and the disagreement is flagged.

import { allocateAmount } from './allocation'
import { roundCents } from './ledger'
import { validCapitalDate } from './capital-operation-key'
import type { DraftChecks, DraftFlag, MissingItem } from '@/lib/drafting/checks'

export const PURPOSE_CATEGORIES = ['investment', 'management_fee', 'fund_expense', 'other'] as const
export type PurposeCategory = typeof PURPOSE_CATEGORIES[number]

export const PURPOSE_LABEL: Record<PurposeCategory, string> = {
  investment: 'Investments',
  management_fee: 'Management fees',
  fund_expense: 'Fund expenses',
  other: 'Other',
}

export interface CallPurpose {
  category: PurposeCategory
  amount: number
  /** What it is: "Series A in Acme", "Q1 2027 management fee". */
  description?: string | null
  /** Fees only: the basis as the user stated it ("2% of commitments, Q1 2027"). Never derived. */
  basis?: string | null
  /** A date this purpose depends on, e.g. the closing it funds. Checked against the notice period. */
  date?: string | null
}

export type NoticePeriodBasis = 'calendar' | 'business'

export interface ProposedCallRequest {
  total: number
  purposes: CallPurpose[]
  /** The date on the notice, when it is sent. */
  noticeDate?: string | null
  dueDate?: string | null
  /** The notice period the user stated, if any. The vehicle's stored LPA term is checked too. */
  noticePeriodDays?: number | null
  noticePeriodBasis?: NoticePeriodBasis | null
  /** A line for the notice body. Built from the purposes when absent. */
  description?: string | null
  /**
   * LP figures the request itself stated ("LP commitment: $5M (10% of fund)"). Never used for the
   * split, which comes from the register; each is compared with it, and a difference is flagged.
   */
  statedPartners?: StatedPartner[] | null
}

/** One LP figure as the user stated it: the LP (entity id or name) and a commitment or share. */
export interface StatedPartner {
  lp: string
  commitment?: number | null
  /** Percent of the vehicle's total commitments, 0..100. */
  sharePct?: number | null
}

/** Stated LP figures as stored: an LP named, and at least one figure that is a number. */
export function normalizeStatedPartners(raw: unknown): StatedPartner[] {
  if (!Array.isArray(raw)) return []
  const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
  return raw
    .map((r: any) => ({ lp: String(r?.lp ?? '').trim(), commitment: num(r?.commitment), sharePct: num(r?.sharePct ?? r?.share_pct) }))
    .filter(r => r.lp && (r.commitment != null || r.sharePct != null))
}

/** What the fund's records say. Loaded by proposed-calls.ts. */
export interface CallFacts {
  vehicle: string
  currency: string
  fundAddress: string | null
  wireInstructions: string | null
  /** The LPA notice period stored on the vehicle, if anyone has recorded it. */
  storedNoticeDays: number | null
  storedNoticeBasis: NoticePeriodBasis | null
  partners: {
    lpEntityId: string
    name: string
    commitment: number
    /** Called before this call, from the register. Null when the books cannot say. */
    calledToDate: number | null
  }[]
  /** YYYY-MM-DD. Only used to flag a backdated notice, never as a default. */
  today: string
}

export interface CheckedCallLine {
  lpEntityId: string
  name: string
  commitment: number
  /** Share of the vehicle's total commitments, 0..1. */
  share: number
  amount: number
  calledToDate: number | null
  /** Commitment still uncalled after this call. Null when calledToDate is unknown. */
  remainingAfter: number | null
}

export interface CheckedCall extends DraftChecks {
  total: number
  purposes: CallPurpose[]
  description: string
  noticeDate: string | null
  dueDate: string | null
  noticePeriod: { days: number; basis: NoticePeriodBasis; source: 'vehicle' | 'request' } | null
  /** The first due date the notice period allows, when the notice date and period are known. */
  earliestDueDate: string | null
  totalCommitments: number
  lines: CheckedCallLine[]
}

const fmt = (n: number, currency: string) =>
  `${currency === 'USD' ? '$' : `${currency} `}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Weekdays only. Public holidays are not known here, which the result says when this is used. */
function addBusinessDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  let left = days
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1)
    const wd = d.getUTCDay()
    if (wd !== 0 && wd !== 6) left--
  }
  return d.toISOString().slice(0, 10)
}

export function earliestDue(noticeDate: string, days: number, basis: NoticePeriodBasis): string {
  return basis === 'business' ? addBusinessDays(noticeDate, days) : addDays(noticeDate, days)
}

const validDays = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 365

/** Normalize what a caller sent: drop junk, keep the order. Throws on nothing; the checks report. */
export function normalizePurposes(raw: unknown): CallPurpose[] {
  if (!Array.isArray(raw)) return []
  const out: CallPurpose[] = []
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue
    const category = (PURPOSE_CATEGORIES as readonly string[]).includes((p as any).category) ? (p as any).category as PurposeCategory : 'other'
    const amount = roundCents(Number((p as any).amount))
    if (!Number.isFinite(amount)) continue
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null)
    out.push({ category, amount, description: s((p as any).description), basis: s((p as any).basis), date: s((p as any).date) })
  }
  return out
}

export function describePurposes(purposes: CallPurpose[], currency: string): string {
  if (purposes.length === 0) return 'Capital call'
  return 'Capital call for ' + purposes
    .map(p => `${p.description || PURPOSE_LABEL[p.category].toLowerCase()} (${fmt(p.amount, currency)})`)
    .join('; ')
}

export function checkCapitalCall(req: ProposedCallRequest, facts: CallFacts): CheckedCall {
  const missing: MissingItem[] = []
  const flags: DraftFlag[] = []
  const total = roundCents(Number(req.total))
  const purposes = normalizePurposes(req.purposes)
  const money = (n: number) => fmt(n, facts.currency)

  // ── The amount and what it is for ─────────────────────────────────────────
  if (!Number.isFinite(total) || total <= 0) {
    flags.push({ code: 'total_invalid', severity: 'blocker', message: 'The total call must be a positive amount.' })
  }
  if (purposes.length === 0) {
    missing.push({
      field: 'purposes', label: 'Purpose of the call, with amounts', required: false,
      why: 'A notice usually states what the capital is for (investments, management fees, fund expenses) and how much of the call each takes. Without it the notice shows the description only.',
    })
  } else {
    const sum = roundCents(purposes.reduce((s, p) => s + p.amount, 0))
    if (purposes.some(p => !(p.amount > 0))) {
      flags.push({ code: 'purpose_amount_invalid', severity: 'blocker', message: 'Every purpose needs a positive amount.' })
    }
    if (Number.isFinite(total) && Math.abs(sum - total) >= 0.005) {
      flags.push({
        code: 'purposes_do_not_sum', severity: 'blocker',
        message: `The purposes add up to ${money(sum)}, not the ${money(total)} total call. Correct one or the other.`,
      })
    }
    purposes.forEach((p, i) => {
      if (p.category === 'management_fee' && !p.basis) {
        missing.push({
          field: `purposes[${i}].basis`, label: 'Management fee basis and period', required: false,
          why: `The ${money(p.amount)} fee is stated without its basis (rate, base and period). The app holds no LPA fee terms, so the notice will show the amount only unless you supply them.`,
        })
      }
    })
  }

  // ── Dates ─────────────────────────────────────────────────────────────────
  const noticeDate = req.noticeDate && validCapitalDate(req.noticeDate) ? req.noticeDate : null
  const dueDate = req.dueDate && validCapitalDate(req.dueDate) ? req.dueDate : null
  if (req.noticeDate && !noticeDate) flags.push({ code: 'notice_date_invalid', severity: 'blocker', message: `"${req.noticeDate}" is not a valid date (YYYY-MM-DD).` })
  if (req.dueDate && !dueDate) flags.push({ code: 'due_date_invalid', severity: 'blocker', message: `"${req.dueDate}" is not a valid date (YYYY-MM-DD).` })
  if (!req.noticeDate) {
    missing.push({
      field: 'notice_date', label: 'Notice date', required: true,
      why: 'The date the notice is sent. The notice period runs from it, so it is not assumed to be today.',
    })
  }
  if (!req.dueDate) {
    missing.push({ field: 'due_date', label: 'Due date', required: true, why: 'The date the capital must arrive by.' })
  }
  if (noticeDate && noticeDate < facts.today) {
    flags.push({ code: 'notice_date_past', severity: 'warning', date: noticeDate, message: `The notice is dated ${noticeDate}, before today. LPs will receive it later than it says.` })
  }
  if (noticeDate && dueDate && dueDate < noticeDate) {
    flags.push({ code: 'due_before_notice', severity: 'blocker', date: dueDate, message: `The due date ${dueDate} is before the notice date ${noticeDate}.` })
  }

  // ── The LPA notice period ─────────────────────────────────────────────────
  const stated = validDays(req.noticePeriodDays) ? req.noticePeriodDays : null
  const stored = validDays(facts.storedNoticeDays) ? facts.storedNoticeDays : null
  let noticePeriod: CheckedCall['noticePeriod'] = null
  if (stored != null && stated != null && stored !== stated) {
    const longer = Math.max(stored, stated)
    flags.push({
      code: 'notice_period_disagrees', severity: 'warning',
      message: `You gave a ${stated}-day notice period; the LPA term recorded for ${facts.vehicle} is ${stored} days. The check uses the longer, ${longer} days.`,
    })
    noticePeriod = stored >= stated
      ? { days: stored, basis: facts.storedNoticeBasis ?? 'calendar', source: 'vehicle' }
      : { days: stated, basis: req.noticePeriodBasis ?? 'calendar', source: 'request' }
  } else if (stored != null) {
    noticePeriod = { days: stored, basis: facts.storedNoticeBasis ?? 'calendar', source: 'vehicle' }
  } else if (stated != null) {
    noticePeriod = { days: stated, basis: req.noticePeriodBasis ?? 'calendar', source: 'request' }
  } else {
    missing.push({
      field: 'notice_period_days', label: 'Notice period required by the LPA', required: false,
      why: `No notice period is recorded for ${facts.vehicle} and none was given, so no date on the notice can be checked against it. Record it on the vehicle once and every call is checked.`,
    })
  }

  let earliestDueDate: string | null = null
  if (noticePeriod && noticeDate) {
    earliestDueDate = earliestDue(noticeDate, noticePeriod.days, noticePeriod.basis)
    const unit = noticePeriod.basis === 'business' ? 'business days' : 'days'
    if (dueDate && dueDate < earliestDueDate) {
      flags.push({
        code: 'due_inside_notice_period', severity: 'warning', date: dueDate,
        message: `The due date ${dueDate} falls inside the ${noticePeriod.days}-${unit} notice period that starts ${noticeDate}. The earliest due date the LPA allows is ${earliestDueDate}, unless the LPs waive it.`,
      })
    }
    purposes.forEach(p => {
      if (p.date && validCapitalDate(p.date) && p.date < earliestDueDate!) {
        flags.push({
          code: 'purpose_date_inside_notice_period', severity: 'warning', date: p.date,
          message: `${p.description || PURPOSE_LABEL[p.category]} is dated ${p.date}, inside the notice period (ends ${earliestDueDate}). The capital may not arrive in time for it.`,
        })
      }
    })
    if (noticePeriod.basis === 'business') {
      flags.push({
        code: 'business_days_without_holidays', severity: 'warning',
        message: `The ${noticePeriod.days}-business-day period counts weekdays only; public holidays are not taken out. Check ${earliestDueDate} against the LPA's definition of a business day.`,
      })
    }
  }

  // ── Where the money goes ──────────────────────────────────────────────────
  if (!facts.wireInstructions) {
    missing.push({
      field: 'wire_instructions', label: 'Wire instructions', required: false,
      why: `None are recorded for ${facts.vehicle}. The notice will say payment instructions follow separately. Add them in the vehicle's settings; they are never typed into a call.`,
    })
  }
  if (!facts.fundAddress) {
    missing.push({ field: 'fund_address', label: 'Fund address for the letterhead', required: false, why: 'The notice letterhead shows the fund name only.' })
  }

  // ── Each LP's share, from stored commitments ──────────────────────────────
  const committed = facts.partners.filter(p => p.commitment > 0)
  const totalCommitments = roundCents(committed.reduce((s, p) => s + p.commitment, 0))
  if (committed.length === 0) {
    missing.push({
      field: 'commitments', label: 'LP commitments', required: true,
      why: `No commitments are recorded for ${facts.vehicle}, so no LP's share can be computed.`,
    })
  }
  const split = committed.length > 0 && total > 0
    ? allocateAmount(total, committed.map(p => ({ lpEntityId: p.lpEntityId, commitment: p.commitment })))
    : new Map<string, number>()
  const lines: CheckedCallLine[] = committed.map(p => {
    const amount = split.get(p.lpEntityId) ?? 0
    const remainingAfter = p.calledToDate == null ? null : roundCents(p.commitment - p.calledToDate - amount)
    return {
      lpEntityId: p.lpEntityId, name: p.name, commitment: p.commitment,
      share: totalCommitments > 0 ? p.commitment / totalCommitments : 0,
      amount, calledToDate: p.calledToDate, remainingAfter,
    }
  })
  for (const l of lines) {
    if (l.remainingAfter != null && l.remainingAfter < -0.005) {
      flags.push({
        code: 'exceeds_uncalled_commitment', severity: 'blocker', subject: l.lpEntityId,
        message: `${l.name}'s share (${money(l.amount)}) is more than their uncalled commitment (${money(roundCents(l.commitment - (l.calledToDate ?? 0)))}).`,
      })
    }
  }

  // ── LP figures the request stated, against the register ───────────────────
  // The split above never reads them. A stale figure in the request is the user's to correct, so
  // each difference is a warning naming both numbers.
  for (const stated of normalizeStatedPartners(req.statedPartners)) {
    const key = stated.lp.toLowerCase()
    const line = lines.find(l => l.lpEntityId === stated.lp) ?? lines.find(l => l.name.trim().toLowerCase() === key)
    if (!line) {
      flags.push({
        code: 'stated_partner_unknown', severity: 'warning',
        message: `"${stated.lp}" is not a partner with a commitment in ${facts.vehicle}, so the figures given for them were not used.`,
      })
      continue
    }
    if (stated.commitment != null && Math.abs(stated.commitment - line.commitment) >= 0.005) {
      flags.push({
        code: 'stated_commitment_differs', severity: 'warning', subject: line.lpEntityId,
        message: `You gave ${line.name}'s commitment as ${money(stated.commitment)}; the register has ${money(line.commitment)}. The split uses the register.`,
      })
    }
    const pct = line.share * 100
    if (stated.sharePct != null && Math.abs(stated.sharePct - pct) >= 0.005) {
      flags.push({
        code: 'stated_share_differs', severity: 'warning', subject: line.lpEntityId,
        message: `You gave ${line.name} as ${stated.sharePct}% of the fund; recorded commitments make it ${pct.toFixed(2)}%. The split uses the register.`,
      })
    }
  }

  return {
    total, purposes,
    description: req.description?.trim() || describePurposes(purposes, facts.currency),
    noticeDate, dueDate, noticePeriod, earliestDueDate, totalCommitments, lines,
    missing, flags,
  }
}
