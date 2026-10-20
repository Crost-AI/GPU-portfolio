// ── GPU fleet (P5) ── The Scenarios page's requests and its one cell formatter. The figures are the
// scenario engine's (lib/gpu/scenario.ts) laid out by lib/gpu/report.ts on the server; the page only
// labels and formats them, so it can never disagree with the export sheets built from the same shapes.

import { addMonths } from '@/lib/forecast/months'
import type { FleetAssumptions } from '@/lib/gpu/scenario'
import type { ReportFormat, ReportRow } from '@/lib/gpu/report'
import type { FleetScenariosResponse } from '@/lib/forecast/service'
import { call, send, type Fetcher } from './fleet-api'

export const SCENARIOS_PATH = '/api/accounting/forecast/fleet-scenarios'

/** The vehicle's fleet scenarios; `planId` picks the detail (the primary when omitted). */
export const getScenarios = (f: Fetcher, planId?: string | null) =>
  call<FleetScenariosResponse>(f, planId ? `${SCENARIOS_PATH}?plan=${encodeURIComponent(planId)}` : SCENARIOS_PATH)

/** Create the six pitch scenarios (idempotent: an already seeded vehicle answers with its plans). */
export const seedScenarios = (f: Fetcher) => send<{ created: number; plans: unknown[] }>(f, SCENARIOS_PATH, 'POST', { action: 'seed' })

/** The parts of GET /api/accounting/forecast/[id] the fleet pages read. */
export interface FleetPlanDetail {
  plan: { id: string; name: string; revision: number; fleet: FleetAssumptions | null }
}

export const getFleetPlan = (f: Fetcher, planId: string) =>
  call<FleetPlanDetail>(f, `/api/accounting/forecast/${encodeURIComponent(planId)}`)

/**
 * One headline or detail cell. Null is a dash, except on a `year` row that is not redacted, where it
 * means capital was never recovered within the fund's life. A redacted row (manager figures without
 * gp_economics) is always a dash, never 0.
 */
export function formatReportValue(v: number | null, format: ReportFormat, money: (n: number) => string, redacted = false): string {
  if (redacted) return '—'
  if (v == null || !Number.isFinite(v)) return format === 'year' && v == null ? 'Not within life' : '—'
  switch (format) {
    case 'usd': return money(v)
    case 'pct': return `${(v * 100).toFixed(1)}%`
    case 'multiple': return `${v.toFixed(2)}x`
    case 'year': return `Year ${v}`
  }
}

/** A row's cells, formatted, with its total when it has one. */
export const formatRow = (r: ReportRow, money: (n: number) => string) => ({
  cells: r.values.map(v => formatReportValue(v, r.format, money, r.redacted)),
  total: r.total == null && !r.redacted ? null : formatReportValue(r.total, r.format, money, r.redacted),
})

/**
 * The existing forecast workbook export for one fleet plan: its fleet sheets (Headline, Series,
 * Detail) come with it. The months run from the plan's start through its sale year.
 */
export function scenarioExportHref(vehicle: string, planId: string, fleet: Pick<FleetAssumptions, 'startMonth' | 'saleYear'>): string {
  const q = new URLSearchParams({
    group: vehicle, plan: planId, format: 'xlsx',
    start: fleet.startMonth, end: addMonths(fleet.startMonth, fleet.saleYear * 12 - 1),
  })
  return `/api/accounting/forecast/export?${q.toString()}`
}

/** The series charts' line colours: the categorical slots in fixed order, one per scenario column. */
export const scenarioHue = (index: number) => `hsl(var(--cat-${Math.min(index, 7) + 1}))`
