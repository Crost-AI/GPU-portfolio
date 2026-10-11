import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { getSeries, getSeriesWithRules, getVariance } from '@/lib/forecast/service'
import { forecastRequest } from '@/lib/forecast/http'
import { seriesCsv, varianceCsv } from '@/lib/forecast/export'
import { buildForecastWorkbook, buildVarianceWorkbook } from '@/lib/forecast/workbook'
import { rateLimit } from '@/lib/rate-limit'

// CSV of exactly what the series route (or, with kind=variance, the variance route) returns for the
// same parameters. With format=xlsx, the same numbers as an Excel model: totals, net income and the
// cash roll-forward as formulas, and rule-driven forecast months as formulas over an Assumptions sheet.

const version = (v: string | null, fallback: string | null) => {
  const x = v ?? fallback
  return x === 'draft' || x === null ? null : x
}

const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '-')

const csv = (body: string, name: string) =>
  new NextResponse(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeName(name)}.csv"`,
    },
  })

const xlsx = (wb: XLSX.WorkBook, name: string) =>
  new NextResponse(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${safeName(name)}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  })

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams
  const excel = q.get('format') === 'xlsx'
  return forecastRequest(req, 'read', async (ctx, vehicle) => {
    if (excel) {
      // A workbook is heavier than the JSON path; cap it like the statements export.
      const limited = await rateLimit({ key: `forecast-export:${ctx.userId}`, limit: 20, windowSeconds: 300 })
      if (limited) return limited
    }
    const meta = async () => {
      const { data: fund } = await (ctx.admin as any).from('funds').select('name').eq('id', ctx.fundId).maybeSingle()
      return { fundName: fund?.name ?? 'Fund', generatedAt: new Date().toISOString() }
    }
    if (q.get('kind') === 'variance') {
      const compare = q.get('compare') ?? 'actual'
      const v = await getVariance(ctx, {
        vehicle,
        base: { planId: q.get('base') ?? '', versionId: version(q.get('baseVersion'), 'approved') },
        compare: compare === 'actual' ? 'actual' : { planId: compare, versionId: version(q.get('compareVersion'), 'draft') },
        start: q.get('start') ?? '',
        end: q.get('end') ?? '',
        interval: (q.get('interval') as any) || undefined,
      })
      const name = `${v.vehicle}-variance-${q.get('start')}-${q.get('end')}`
      return excel ? xlsx(buildVarianceWorkbook(v, await meta()), name) : csv(varianceCsv(v), name)
    }
    const input = {
      vehicle,
      planId: q.get('plan') || undefined,
      versionId: q.get('version') || undefined,
      view: (q.get('view') as any) || undefined,
      start: q.get('start') ?? '',
      end: q.get('end') ?? '',
    }
    if (excel) {
      const interval = (q.get('interval') as any) || 'month'
      if (!['month', 'quarter', 'year'].includes(interval)) return NextResponse.json({ error: "interval must be 'month', 'quarter' or 'year'" }, { status: 400 })
      // Every formula is written at the monthly grain; quarters and years are SUMs of months.
      const { series, rules, accounts } = await getSeriesWithRules(ctx, { ...input, interval: 'month' })
      const wb = buildForecastWorkbook({ monthly: series, rules, accounts, interval, meta: await meta() })
      return xlsx(wb, `${series.vehicle}-${series.plan?.name ?? 'actuals'}-${q.get('start')}-${q.get('end')}`)
    }
    const series = await getSeries(ctx, { ...input, interval: (q.get('interval') as any) || undefined })
    return csv(seriesCsv(series), `${series.vehicle}-${series.plan?.name ?? 'actuals'}-${q.get('start')}-${q.get('end')}`)
  })
}
