import { NextRequest } from 'next/server'
import { getPlanReturns } from '@/lib/forecast/service'
import { forecastRequest } from '@/lib/forecast/http'

// A plan's returns — calls, distributions, carry and the LPs' net figures by year, from the plan's
// own entries — and, with ?simulate=1, their range across simulated exits. Omit ?plan for the
// entity's primary plan. Portfolio construction's yearly views read this.

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams
  return forecastRequest(req, 'read', (ctx, vehicle) =>
    getPlanReturns(ctx, { vehicle, planId: q.get('plan') || null, simulate: q.get('simulate') === '1' }),
  )
}
