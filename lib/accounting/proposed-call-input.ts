// A proposed capital call as a caller sends it, in camelCase (the route) or snake_case (the agent
// action). Shape checks only: whether the values make a good call is capital-call-check.ts's job,
// which reports rather than refuses, so a proposal with gaps can still be saved and shown.

import { normalizePurposes, type ProposedCallRequest } from './capital-call-check'

const pick = (raw: any, camel: string, snake: string) => (raw?.[camel] !== undefined ? raw[camel] : raw?.[snake])

export function proposedCallRequestFrom(
  raw: any, opts: { partial?: boolean } = {},
): { request: ProposedCallRequest } | { error: string } {
  const out: Partial<ProposedCallRequest> = {}

  const total = pick(raw, 'total', 'total')
  if (total !== undefined) {
    const n = Number(total)
    if (!Number.isFinite(n)) return { error: 'total must be a number' }
    out.total = n
  } else if (!opts.partial) return { error: 'total is required' }

  const purposes = pick(raw, 'purposes', 'purposes')
  if (purposes !== undefined) {
    if (!Array.isArray(purposes)) return { error: 'purposes must be a list of { category, amount }' }
    out.purposes = normalizePurposes(purposes)
  } else if (!opts.partial) out.purposes = []

  for (const [camel, snake] of [['noticeDate', 'notice_date'], ['dueDate', 'due_date'], ['description', 'description']] as const) {
    const v = pick(raw, camel, snake)
    if (v === undefined) continue
    if (v !== null && typeof v !== 'string') return { error: `${snake} must be a string` }
    ;(out as any)[camel] = v && v.trim() ? v.trim() : null
  }

  const days = pick(raw, 'noticePeriodDays', 'notice_period_days')
  if (days !== undefined) {
    if (days !== null && !(Number.isInteger(days) && days >= 0 && days <= 365)) return { error: 'notice_period_days must be a whole number of days, 0 to 365' }
    out.noticePeriodDays = days
  }
  const basis = pick(raw, 'noticePeriodBasis', 'notice_period_basis')
  if (basis !== undefined) {
    if (basis !== null && basis !== 'calendar' && basis !== 'business') return { error: "notice_period_basis must be 'calendar' or 'business'" }
    out.noticePeriodBasis = basis
  }

  return { request: out as ProposedCallRequest }
}
