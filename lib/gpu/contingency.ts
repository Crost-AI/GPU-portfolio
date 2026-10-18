// The capex contingency (decision R8): real installation, shipping and spares are capitalized into
// each asset; what is left of the budget raised for them goes back to investors as return of
// capital. Pure. Nothing here books anything: gpu-P2 decides when to distribute it.

const cents = (n: number) => Math.round(n * 100)

export interface ContingencyPosition {
  budget: number
  /** Σ capitalized_costs across the vehicle's assets, disposed ones included (spent is spent). */
  spent: number
  /** What can be returned as ROC; never negative. */
  unspent: number
  /** Spend beyond the budget; 0 when within it. */
  overrun: number
}

export function contingencyPosition(budget: number, assets: { capitalized_costs: number | null }[]): ContingencyPosition {
  const b = cents(budget)
  const spent = assets.reduce((s, a) => s + cents(Number(a.capitalized_costs ?? 0)), 0)
  return { budget: b / 100, spent: spent / 100, unspent: Math.max(0, b - spent) / 100, overrun: Math.max(0, spent - b) / 100 }
}

/** budget − Σ capitalized_costs, floored at zero: the contingency available to return as ROC. */
export function unspentContingency(budget: number, assets: { capitalized_costs: number | null }[]): number {
  return contingencyPosition(budget, assets).unspent
}
