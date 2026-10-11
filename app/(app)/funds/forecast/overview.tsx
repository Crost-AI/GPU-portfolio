'use client'

import { Loader2 } from 'lucide-react'
import { Metric } from '@/components/ui/metric'
import type { PlanReturnsResponse } from '@/lib/forecast/service'

type Fmt = (v: number | null) => string

/**
 * The top of the Forecast page: the few figures every choice moves, above all four tabs
 * (plans/plan-unified-plan.md §5). A deal's exit, a fee rate, a payout lag — each lands here as
 * soon as it is saved, because it is one calculation (lib/forecast/plan-returns.ts) over the plan.
 * The page fetches the plan's returns once (with the simulation) and hands them to this and to the
 * charts, so the figures and the cash-flow range come from the same response.
 */
export function PlanOverview({ planId, data, error, fmt }: { planId: string | null; data: PlanReturnsResponse | null; error: string | null; fmt: Fmt }) {
  if (!planId) return null
  if (error) return <p className="mb-4 text-sm text-destructive">{error}</p>
  if (!data) return <div className="mb-6 flex h-24 items-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>

  const { base, gross } = data
  const x = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(2)}x`)
  const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
  return (
    <section className="mb-6 space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Metric label="Forecast gross MOIC" value={x(gross.moic)} />
        <Metric label="Forecast LP TVPI" value={x(base.lp.tvpi)} />
        <Metric label="Forecast LP IRR" value={pct(base.lp.irr)} />
        <Metric label="Distributions to come" value={fmt(base.totals.distributed)} />
        <Metric label="Carry to come" value={fmt(base.totals.carry)} />
      </div>
    </section>
  )
}
