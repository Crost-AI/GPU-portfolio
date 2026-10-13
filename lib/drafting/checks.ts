// The shape a check returns alongside anything proposed for review: what is missing, and what is
// wrong. Shared so a proposed capital call, an LP letter and a close checklist report gaps the same
// way, in chat and on the page.
//
// The app decides both lists from its own records and the request, deterministically. A model
// writing prose around a draft reads them and repeats them; it never fills a gap itself. That is
// the point of the split: a date, a wire instruction or a fee term the records do not hold is
// listed here, not invented in the text.

/** Something the draft needs that neither the request nor the fund's records supplied. */
export interface MissingItem {
  /** Stable key, e.g. `due_date`, `wire_instructions`. */
  field: string
  /** What it is, in the user's words. */
  label: string
  /** Why the draft needs it, and where it would come from. */
  why: string
  /** True when the draft cannot be approved without it. */
  required: boolean
}

/**
 * A problem with what WAS supplied.
 *   blocker: the draft cannot be approved until it is fixed.
 *   warning: approval is allowed, but the approver must acknowledge it.
 */
export interface DraftFlag {
  code: string
  severity: 'blocker' | 'warning'
  message: string
  /** The date the flag is about, when it is about one (YYYY-MM-DD). */
  date?: string
  /** The record the flag is about, when it is about one (an LP entity id). */
  subject?: string
}

export interface DraftChecks {
  missing: MissingItem[]
  flags: DraftFlag[]
}

/** Nothing required is missing and nothing blocks. Warnings may remain. */
export function approvable(c: DraftChecks): boolean {
  return !c.missing.some(m => m.required) && !c.flags.some(f => f.severity === 'blocker')
}

/** What an approver has to acknowledge: every warning, and every missing item that is not required. */
export function needsAcknowledgement(c: DraftChecks): boolean {
  return c.flags.some(f => f.severity === 'warning') || c.missing.some(m => !m.required)
}
