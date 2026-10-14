/**
 * The day a metric value's reporting period ends (YYYY-MM-DD): a monthly row at month end, a
 * quarterly row at quarter end, an annual row at 31 December. A row carrying both a month and its
 * quarter is the month. "Latest" orders by this, then by created_at for a re-imported period (see
 * the views for the remaining tie-breaks).
 *
 * Mirrors `period_end` in the metric_values_latest views
 * (supabase/migrations/20261014180000_metric_values_latest_views.sql); keep the two in step.
 */
export function periodEnd(year: number, quarter: number | null, month: number | null): string {
  const m = month ?? (quarter != null ? quarter * 3 : 12)
  return new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10)
}

