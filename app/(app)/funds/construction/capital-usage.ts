import type { ConstructionResult } from '@/lib/accounting/construction'

/**
 * Where the commitment goes, as the Committed capital usage chart draws it: every slot non-negative
 * and, while the plan fits, summing to committed capital exactly.
 *
 * What is left over once every use is counted (actual and forecast) is split by whether it has been
 * called. Uses are funded from called capital first — what has been paid was paid from calls, and
 * the forecast spends cash on hand before it asks for more — so the called part of the leftover is
 * whatever the calls to date exceed every use by, and the rest of the leftover is still uncalled.
 * When the calls to date have not even covered what has been paid (fees paid ahead of a call,
 * recycled proceeds), nothing called is left over and the whole leftover is uncalled.
 *
 * Without a called figure (`calledKnown` false — a tracking-only vehicle) the leftover stays one
 * "unallocated" slot: splitting it on a zero would call it all uncalled, which is a claim, not a gap.
 */
export interface CapitalUsage {
  deployed: number
  planned: number
  feesActual: number
  feesForecast: number
  expensesActual: number
  expensesForecast: number
  /** Leftover, when the called figure is unknown. 0 otherwise. */
  unallocated: number
  /** Called to date and not yet spent or earmarked by the forecast. */
  calledUnallocated: number
  /** Leftover the partners have not been asked for yet. */
  uncalledUnallocated: number
  /** Called to date, clamped to [0, committed]. */
  called: number
  /** committed − called: the full uncalled commitment, part of which the forecast already earmarks. */
  uncalled: number
}

type Capital = Pick<ConstructionResult['capital'],
  'committedCapital' | 'calledCapital' | 'deployedTotal' | 'plannedCost' |
  'feesIncurred' | 'feesProjected' | 'orgCostsIncurred' | 'orgCostsProjected' | 'expensesIncurred' | 'expensesProjected'>

const pos = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0)

export function capitalUsage(capital: Capital, { calledKnown }: { calledKnown: boolean }): CapitalUsage {
  const committed = pos(capital.committedCapital)
  const deployed = pos(capital.deployedTotal)
  const planned = pos(capital.plannedCost)
  const feesActual = pos(capital.feesIncurred)
  const feesForecast = pos(capital.feesProjected)
  const expensesActual = pos(capital.orgCostsIncurred) + pos(capital.expensesIncurred)
  const expensesForecast = pos(capital.orgCostsProjected) + pos(capital.expensesProjected)
  const used = deployed + planned + feesActual + feesForecast + expensesActual + expensesForecast
  // A plan that overruns has nothing left over — the shortfall is a warning elsewhere, and a
  // negative area would break the "these sum to committed" reading.
  const leftover = Math.max(0, committed - used)
  const called = Math.min(committed, pos(capital.calledCapital))
  const uncalled = committed - called
  const base = { deployed, planned, feesActual, feesForecast, expensesActual, expensesForecast, called, uncalled }
  if (!calledKnown) return { ...base, unallocated: leftover, calledUnallocated: 0, uncalledUnallocated: 0 }
  const calledUnallocated = Math.min(leftover, Math.max(0, called - used))
  return { ...base, unallocated: 0, calledUnallocated, uncalledUnallocated: leftover - calledUnallocated }
}
