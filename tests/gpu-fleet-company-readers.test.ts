import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DASHBOARD_HOLDING_TYPES } from '@/lib/dashboard/entity-selection'

// ── GPU fleet (P3) ── #91, the fund-wide readers. These read companies, metrics or the latest-value
// views with the service role across the whole fund (RLS is out of the path), and a GPU SPV's fleet
// company must not reach a caller without fleet through them. Each one below already keeps to
// operating companies (holding_type 'company', or a list without 'gpu_fleet'); this pins that, so a
// later edit cannot drop the filter. The audit table is in the PR B description.

const read = (f: string) => readFileSync(path.join(process.cwd(), f), 'utf8')
const COMPANY_ONLY = /\.eq\(\s*'holding_type',\s*'company'\s*\)/

/** Reader → the file whose companies read keeps to holding_type 'company'. */
const FILTERED: [string, string][] = [
  ['dashboard page (latest cash, last report)', 'app/(app)/dashboard/load.ts'],
  ['dashboard table data (metric values, latest views)', 'app/api/dashboard/table-data/route.ts'],
  ['LP-letter aggregation', 'lib/lp-letters/aggregate.ts'],
  ['agent query datasets (metrics, metric values)', 'lib/agent/query/datasets.ts'],
  ['Analyst portfolio context', 'lib/ai/context-builder.ts'],
  ['Analyst cross-reference name lookup', 'lib/ai/analyst/orchestrator.ts'],
  ['reporting reminders', 'lib/reminders/load.ts'],
  ['quarter request status', 'lib/requests/quarter-status.ts'],
  ['request responses', 'app/api/requests/responses/route.ts'],
  ['company list (GET /api/companies)', 'app/api/companies/route.ts'],
  ['company-updates page', 'app/(app)/company-updates/load.ts'],
  ['dashboard notes company list', 'app/api/dashboard/notes/route.ts'],
  ['portfolio import matching', 'app/api/import/route.ts'],
  ['agent summary-generation candidates', 'lib/agent/server-ai-tools.ts'],
]

describe('fund-wide readers keep the fleet company out', () => {
  it.each(FILTERED)('%s (%s) filters holding_type = company', (_, file) => {
    expect(read(file)).toMatch(COMPANY_ONLY)
  })

  it('the dashboard entity picker’s holding types do not include gpu_fleet', () => {
    expect([...DASHBOARD_HOLDING_TYPES]).not.toContain('gpu_fleet')
    expect(read('lib/dashboard/entity-selection-load.ts')).toMatch(/\.in\('holding_type', \[\.\.\.DASHBOARD_HOLDING_TYPES\]\)/)
  })

  it('the start page counts operating companies and fund holdings only', () => {
    expect(read('app/(app)/start/layout.tsx')).toMatch(/\.in\('holding_type', \['company', 'fund'\]\)/)
  })

  it('the Analyst’s company-scoped chat and conversation creation refuse a fleet company without fleet', () => {
    expect(read('lib/ai/analyst/orchestrator.ts')).toMatch(/fleetCompanyDenied\(principal\.access, companyCheck\.holding_type\)/)
    expect(read('app/api/analyst/conversations/route.ts')).toMatch(/fleetCompanyDenied\(scope\.access, companyCheck\.holding_type\)/)
  })
})
