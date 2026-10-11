/**
 * Whether the entity has a cash-flow forecast for the Charts tab to draw.
 *
 * A forecast is a plan whose draft compiles to entries of its own — rules, construction flows
 * (investments, calls, exits), capital edits, hand entries. An `opening` entry only settles a balance
 * the actuals already hold, so a plan with nothing else forecasts nothing. Without a forecast the
 * cash-flow, multiples, income and cash charts would plot actuals against an empty future; the
 * simulation and committed capital usage read the portfolio construction and the calls to date, so
 * they stand on their own.
 *
 * 'unknown' while the plan list or the selected plan is still loading: the page shows neither the
 * forecast charts nor the note, rather than flashing charts it then takes away.
 */
export type CashFlowForecastState = 'unknown' | 'none' | 'present'

export function cashFlowForecastState(
  plans: readonly unknown[] | null,
  planId: string,
  detail: { plan: { id: string }; entries: readonly { source: string }[] } | null,
): CashFlowForecastState {
  if (plans === null) return 'unknown'
  if (plans.length === 0 || !planId) return 'none'
  if (!detail || detail.plan.id !== planId) return 'unknown'
  return detail.entries.some(e => e.source !== 'opening') ? 'present' : 'none'
}
