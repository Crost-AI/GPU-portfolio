import { NextResponse } from 'next/server'
import { lastQuarterEnd, PERFORMANCE_GROUPINGS, type PerformanceGrouping } from './fund-performance'

/**
 * The fund performance routes' shared query: ?asOf=YYYY-MM-DD (default: the last quarter end)
 * and ?groupBy=date|month|quarter (default: month). A 400 response on bad input.
 */
export function performanceParams(sp: URLSearchParams): { asOf: string; grouping: PerformanceGrouping } | NextResponse {
  const asOf = sp.get('asOf') || lastQuarterEnd(new Date().toISOString().slice(0, 10))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return NextResponse.json({ error: 'asOf must be YYYY-MM-DD' }, { status: 400 })
  const grouping = (sp.get('groupBy') || 'month') as PerformanceGrouping
  if (!PERFORMANCE_GROUPINGS.includes(grouping)) return NextResponse.json({ error: 'groupBy must be date, month or quarter' }, { status: 400 })
  return { asOf, grouping }
}
