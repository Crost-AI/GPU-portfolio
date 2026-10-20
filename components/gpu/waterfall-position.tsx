import { Metric } from '@/components/ui/metric'
import type { PositionTiles as Position } from './waterfall-api'

// ── GPU fleet (P5) ── The investors' position, from the pref-ledger rows and the history
// (positionFromLedger). Investors' figures only: the manager's share is not a tile here, and
// nothing on this page is an accrual (Karl, Q8).

const dash = '—'

export function PositionTiles({ position, money, scopeCaption, unavailable }: {
  position: Position | null
  money: (n: number) => string
  /** What the distributed figure sums: the history shown, not a lifetime total. */
  scopeCaption?: string
  /** Why there is no position (the ledger refused or is loading), shown under every tile. */
  unavailable?: string
}) {
  const p = position
  const v = (n: number | undefined) => (p && n != null ? money(n) : dash)
  const sub = p ? undefined : unavailable
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-region="position">
      <Metric label="Contributed" value={v(p?.contributed)} sub={sub} />
      <Metric label="Capital returned" value={v(p?.capitalReturned)} sub={sub} />
      <Metric label="Unreturned capital" value={v(p?.unreturned)} sub={sub} />
      <Metric label="Pref paid" value={v(p?.prefPaid)} sub={sub} />
      <Metric label="Pref carried forward" value={v(p?.prefCarriedForward)} sub={sub ?? 'Owed, not yet paid; not compounded'} />
      <Metric label="Distributed to investors" value={v(p?.distributedToInvestors)} sub={sub ?? scopeCaption} />
      <Metric label="DPI" value={p?.dpi != null ? `${p.dpi.toFixed(2)}x` : dash} sub={sub ?? scopeCaption} />
    </div>
  )
}
