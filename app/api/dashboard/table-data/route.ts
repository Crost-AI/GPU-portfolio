import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { scopeCompanyRows, scopeGroups } from '@/lib/access/scope'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const fundId = membership.fund_id

  // Fetch active companies with their active metrics
  const { data: companiesRaw, error: compError } = await admin
    .from('companies')
    .select(`
      id, name, stage, industry, portfolio_group, tags,
      metrics(id, name, unit, unit_position, value_type, currency, display_order, is_active)
    `)
    .eq('fund_id', fundId)
    .eq('holding_type', 'company')   // fund holdings have their own surfaces
    .eq('status', 'active')
    .order('name')

  if (compError) return dbError(compError, 'dashboard-table-data')

  // Only companies linked to the caller's entities.
  const scope = await loadEntityScopeForUser(admin, user.id)
  const companies = scopeCompanyRows((companiesRaw ?? []) as any[], (scope ? scope.companyIds : [])) as {
    id: string
    name: string
    stage: string | null
    industry: string[] | null
    portfolio_group: string[] | null
    tags: string[]
    metrics: { id: string; name: string; unit: string | null; unit_position: string; value_type: string; currency: string | null; display_order: number; is_active: boolean }[]
  }[]

  // Collect all active metric IDs
  const allMetricIds: string[] = []
  for (const c of companies) {
    for (const m of c.metrics ?? []) {
      if (m.is_active) allMetricIds.push(m.id)
    }
  }

  // Batch fetch metric values for period_year >= 2025
  let allValues: {
    metric_id: string
    period_year: number
    period_quarter: number | null
    period_month: number | null
    value_number: number | null
    value_text: string | null
  }[] = []

  if (allMetricIds.length > 0) {
    const { data: valuesRaw, error: valError } = await admin
      .from('metric_values')
      .select('metric_id, period_year, period_quarter, period_month, value_number, value_text')
      .in('metric_id', allMetricIds)
      .gte('period_year', 2025)
      .order('period_year', { ascending: true })
      .order('period_month', { ascending: true, nullsFirst: true })

    if (valError) return dbError(valError, 'dashboard-table-data')
    allValues = valuesRaw ?? []
  }

  // Index values by metric_id
  const valuesByMetric = new Map<string, typeof allValues>()
  for (const v of allValues) {
    if (!valuesByMetric.has(v.metric_id)) valuesByMetric.set(v.metric_id, [])
    valuesByMetric.get(v.metric_id)!.push(v)
  }

  // Find cash metric per company for latestCash
  const cashMetricMap = new Map<string, string>()
  for (const c of companies) {
    const cashMetric = (c.metrics ?? []).find(m =>
      m.is_active && /\bcash\b/i.test(m.name)
    )
    if (cashMetric) cashMetricMap.set(c.id, cashMetric.id)
  }

  // Fetch latest cash values: the latest reporting period's, not the latest import — one row per
  // metric from metric_values_latest (its migration says how "latest" is picked). Ids go in chunks
  // of 200: each is a uuid in the GET query string, so a chunk keeps the URL under the gateway's
  // limit, and one row per id keeps the response under PostgREST's 1,000-row cap.
  const cashMetricIds = Array.from(cashMetricMap.values())
  const cashValues = new Map<string, number>()
  const cashChunks: string[][] = []
  for (let i = 0; i < cashMetricIds.length; i += 200) cashChunks.push(cashMetricIds.slice(i, i + 200))
  const cashReads = await Promise.all(cashChunks.map(chunk => admin
    .from('metric_values_latest' as any)
    .select('metric_id, value_number')
    .in('metric_id', chunk)))
  for (const { data: cashRows, error: cashError } of cashReads) {
    if (cashError) return dbError(cashError, 'dashboard-table-data')
    for (const row of (cashRows ?? []) as unknown as { metric_id: string; value_number: number }[]) {
      cashValues.set(row.metric_id, row.value_number)
    }
  }

  // Map monthly/quarterly/annual values to quarters
  function toQuarterKey(year: number, quarter: number): string {
    return `Q${quarter} ${year}`
  }

  function mapToQuarter(v: typeof allValues[0]): { key: string; month: number } | null {
    if (v.period_month != null) {
      const q = Math.ceil(v.period_month / 3)
      return { key: toQuarterKey(v.period_year, q), month: v.period_month }
    }
    if (v.period_quarter != null) {
      return { key: toQuarterKey(v.period_year, v.period_quarter), month: v.period_quarter * 3 }
    }
    // Annual → Q4
    return { key: toQuarterKey(v.period_year, 4), month: 12 }
  }

  const result = companies.map(c => {
    const activeMetrics = (c.metrics ?? [])
      .filter(m => m.is_active)
      .sort((a, b) => a.display_order - b.display_order)

    const cashMetricId = cashMetricMap.get(c.id)
    const latestCash = cashMetricId ? cashValues.get(cashMetricId) ?? null : null

    return {
      id: c.id,
      name: c.name,
      stage: c.stage,
      industry: c.industry,
      portfolioGroup: scopeGroups(c.portfolio_group, (scope ? scope.vehicleNames : [])),
      tags: c.tags ?? [],
      latestCash,
      metrics: activeMetrics.map(m => {
        const metricValues = valuesByMetric.get(m.id) ?? []
        const quarterMap = new Map<string, { value: number | string | null; month: number }>()

        for (const v of metricValues) {
          const mapped = mapToQuarter(v)
          if (!mapped) continue

          const val = m.value_type === 'text' ? v.value_text : v.value_number
          const existing = quarterMap.get(mapped.key)

          // Keep the latest month's value within a quarter
          if (!existing || mapped.month > existing.month) {
            quarterMap.set(mapped.key, { value: val, month: mapped.month })
          }
        }

        const values: Record<string, number | string | null> = {}
        quarterMap.forEach((entry, key) => {
          values[key] = entry.value
        })

        return {
          id: m.id,
          name: m.name,
          unit: m.unit,
          unitPosition: m.unit_position,
          valueType: m.value_type,
          currency: m.currency,
          values,
        }
      }),
    }
  })

  return NextResponse.json({ companies: result })
}
