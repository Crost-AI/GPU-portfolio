'use client'

import { useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatCurrency, useCurrency } from '@/components/currency-context'
import type { FundPositionPoint } from '@/lib/portfolio/fund-position-series'

type View = 'capital' | 'multiples'

/**
 * Colour follows the series, never its rank (DESIGN.md, categorical slots in fixed order). Distributed
 * and DPI are the same money, so they share a slot.
 */
const SERIES: Record<View, { key: keyof FundPositionPoint; label: string; color: string; step?: boolean }[]> = {
  capital: [
    { key: 'contributed', label: 'Contributed', color: 'hsl(var(--cat-1))', step: true },
    { key: 'distributed', label: 'Distributed', color: 'hsl(var(--cat-2))', step: true },
    { key: 'reportedNav', label: 'Reported NAV', color: 'hsl(var(--cat-3))' },
  ],
  multiples: [
    { key: 'tvpi', label: 'TVPI', color: 'hsl(var(--cat-4))' },
    { key: 'dpi', label: 'DPI', color: 'hsl(var(--cat-2))' },
  ],
}

const short = (v: number) => {
  const a = Math.abs(v)
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (a >= 1_000) return `${(v / 1_000).toFixed(0)}K`
  return String(v)
}
const multiple = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(2)}x`)

/**
 * A fund holding's position over time, built from its register: confirmed calls and distributions,
 * cumulative, and the manager's NAV on each statement date — or, on the second view, TVPI and DPI.
 * Two views rather than one chart with two y-axes: money and multiples do not share a scale.
 */
export function FundPositionChart({ points }: { points: FundPositionPoint[] }) {
  const currency = useCurrency()
  const [view, setView] = useState<View>('capital')

  if (points.length === 0) {
    return <p className="text-sm text-muted-foreground">The chart starts with the first confirmed notice or NAV statement.</p>
  }

  const series = SERIES[view]
  const fmt = (v: number | null | undefined) => (v == null ? '—' : view === 'capital' ? formatCurrency(Number(v), currency) : multiple(v))

  return (
    <div className="rounded-card border bg-card p-4 space-y-2" data-chart="fund-position">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
          {series.map(s => (
            <li key={s.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
        <div className="inline-flex rounded-md border text-[10px]" role="group" aria-label="Chart view">
          {(['capital', 'multiples'] as const).map((v, i) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`px-2 py-0.5 ${i === 0 ? 'rounded-l-md' : 'rounded-r-md'} transition-colors ${view === v ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {v === 'capital' ? 'Capital' : 'TVPI / DPI'}
            </button>
          ))}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} className="text-muted-foreground tabular-nums" tickLine={false} axisLine={false}
                 interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 11 }} className="text-muted-foreground tabular-nums" tickLine={false} axisLine={false} width={56}
                 tickFormatter={(v: number) => (view === 'capital' ? short(v) : `${v.toFixed(1)}x`)} />
          <Tooltip
            formatter={(val: any, name: any) => [fmt(val as number), series.find(s => s.key === name)?.label ?? name]}
            contentStyle={{
              borderRadius: '6px',
              border: '1px solid hsl(var(--border))',
              backgroundColor: 'hsl(var(--popover))',
              color: 'hsl(var(--popover-foreground))',
              fontSize: '12px',
              fontVariantNumeric: 'tabular-nums',
            }}
          />
          {series.map(s => (
            <Line
              key={s.key}
              dataKey={s.key}
              name={s.key}
              type={s.step ? 'stepAfter' : 'monotone'}
              stroke={s.color}
              strokeWidth={2}
              connectNulls
              isAnimationActive={false}
              dot={s.key === 'reportedNav' ? { r: 4, fill: s.color, stroke: 'hsl(var(--card))', strokeWidth: 2 } : false}
              activeDot={{ r: 5, stroke: 'hsl(var(--card))', strokeWidth: 2 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
