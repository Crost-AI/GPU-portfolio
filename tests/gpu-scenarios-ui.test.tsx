// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

/**
 * ── GPU fleet (P5) ── The Scenarios page (P5-5), on the model pack's own numbers.
 *
 * The fixtures are the scenario engine run on the pack's six scenarios (lib/gpu/fixtures/pack-v3-fleet)
 * and laid out by the same report functions the route uses, so the headline below is what the route
 * would send. Rendered in a real DOM (happy-dom) because the seed button and the scenario picker are
 * interactions.
 */

import { CurrencyProvider } from '@/components/currency-context'
import { AccessProvider, type ClientAccess } from '@/components/access-context'
import { VehicleScope } from '@/components/accounting-vehicle'
import { AssumptionsSummary, HeadlineTable, InvestorFlowBlocks, ScenariosView } from '@/components/gpu/scenarios-view'
import { baseCaseReturns, formatReportValue, getVehicleScenarios, scenarioExportHref } from '@/components/gpu/scenarios-api'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { redactScenarioResult, resolveFleet, runFleetScenario, type FleetAssumptions, type FleetScenarioResult } from '@/lib/gpu/scenario'
import { scenarioComparison, scenarioDetail } from '@/lib/gpu/report'
import { PACK_SCENARIOS, type PackScenarioId } from '@/lib/gpu/fixtures/pack-v3'
import { PACK_SCENARIO_TERMS, packAssumptions } from '@/lib/gpu/fixtures/pack-v3-fleet'
import type { FleetScenariosResponse } from '@/lib/forecast/service'
import { FleetAssumptionsForm } from '@/components/gpu/fleet-assumptions-form'
import { fromFleetForm, saveFleetPlan, staleMessage, toFleetForm } from '@/components/gpu/fleet-assumptions'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const IDS: PackScenarioId[] = ['base', 'balanced', 'demand_led', 'oversupply', 'oversupply_60', 'oversupply_50']
const planId = (id: PackScenarioId) => `plan-${id}`
const PLANS = IDS.map(id => ({ id: planId(id), name: PACK_SCENARIOS[id].label, scenario: id, isPrimary: id === 'base' }))

function run(id: PackScenarioId, patch: Partial<FleetAssumptions> = {}): FleetScenarioResult {
  const a = packAssumptions(id, patch)
  return runFleetScenario(a, resolveFleet(a, null), PACK_SCENARIO_TERMS)
}

/** What GET fleet-scenarios answers for the six pack scenarios, for a caller with or without gp_economics. */
function response(showCarry: boolean, patch: Partial<FleetAssumptions> = {}): FleetScenariosResponse {
  const raw = Object.fromEntries(IDS.map(id => [planId(id), run(id, patch)]))
  const detail = raw[planId('base')]
  return {
    results: Object.fromEntries(Object.entries(raw).map(([k, r]) => [k, redactScenarioResult(r, showCarry)])),
    comparison: scenarioComparison(raw, { showCarry }),
    detail: scenarioDetail(detail, { showCarry }),
    cadence: detail.cadence,
    primaryPlanId: planId('base'),
    plans: PLANS,
    warnings: [],
  }
}

const ADMIN: ClientAccess = {
  role: 'admin', grants: {}, defaults: {},
  features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', gpu_fleet: 'everyone' } as FeatureVisibilityMap,
}
const MEMBER_READ: ClientAccess = { ...ADMIN, role: 'member', grants: { accounting: 'read' } }

const wrap = (ui: React.ReactNode, access: ClientAccess = ADMIN) => (
  <AccessProvider value={access}>
    <CurrencyProvider currency="USD">
      <VehicleScope vehicle="H200 SPV I" vehicleId="v1">{ui}</VehicleScope>
    </CurrencyProvider>
  </AccessProvider>
)

/** The cells of headline row `key`, in column order. */
const headlineRow = (key: string) =>
  [...document.querySelectorAll(`tr[data-row="${key}"] td`)].map(td => td.textContent)

describe('the six-way headline, on the pack’s numbers', () => {
  beforeEach(() => {
    render(wrap(<HeadlineTable comparison={response(true).comparison} plans={PLANS} primaryPlanId={planId('base')} />))
  })

  it('names the columns in the pack’s order', () => {
    expect([...document.querySelectorAll('thead th[data-plan]')].map(th => th.textContent?.replace('(primary)', '')))
      .toEqual(['Base case', 'Balanced', 'Demand-led', 'Oversupply', 'Oversupply, 60% util', 'Oversupply, 50% util'])
  })

  it('shows the pack’s six investor multiples and IRRs', () => {
    expect(headlineRow('investorMultiple')).toEqual(['2.02x', '2.29x', '2.94x', '1.43x', '1.14x', '0.87x'])
    expect(headlineRow('investorIrr')).toEqual(['33.6%', '39.4%', '53.0%', '17.2%', '5.5%', '-5.2%'])
  })

  it('shows when capital comes back, and Not within life when it never does', () => {
    expect(headlineRow('capitalRecoveredYear')).toEqual(['Year 2', 'Year 2', 'Year 2', 'Year 3', 'Year 4', 'Not within life'])
  })

  it('shows utilization and the pack’s total cash to investors', () => {
    expect(headlineRow('utilization')).toEqual(['75.0%', '75.0%', '75.0%', '75.0%', '60.0%', '50.0%'])
    expect(headlineRow('totalToInvestors')).toEqual(['$2,906,576', '$3,290,599', '$4,214,544', '$2,048,228', '$1,637,756', '$1,250,704'])
  })

  it('highlights the primary scenario’s column', () => {
    const head = document.querySelector(`thead th[data-plan="${planId('base')}"]`)!
    expect(head.className).toMatch(/bg-brand-50/)
    expect(head.className).toMatch(/text-brand-700/)
    expect(head.className).toMatch(/dark:text-brand-400/)
    expect(document.querySelector(`tr[data-row="investorIrr"] td[data-plan="${planId('base')}"]`)!.className).toMatch(/bg-brand-50/)
    expect(document.querySelector(`thead th[data-plan="${planId('balanced')}"]`)!.className).not.toMatch(/bg-brand-50/)
  })
})

describe('without gp_economics', () => {
  it('manager rows are dashes with a lock, never 0', () => {
    render(wrap(<HeadlineTable comparison={response(false).comparison} plans={PLANS} primaryPlanId={planId('base')} />))
    for (const key of ['managerProfitShare', 'managerTotal']) {
      expect(headlineRow(key)).toEqual(Array(6).fill('—'))
      const row = document.querySelector(`tr[data-row="${key}"]`)!
      expect(row.textContent).not.toMatch(/\$0\b/)
      expect(within(row as HTMLElement).getByLabelText('Needs GP economics access')).toBeTruthy()
    }
    // The fee is an SPV expense, not the manager's share: it stays.
    expect(headlineRow('managementFees').every(c => /^\$\d/.test(c ?? ''))).toBe(true)
  })
})

describe('investor flows, one block per cadence', () => {
  it('shows the annual and the vehicle-cadence block, each labelled, when both exist', () => {
    const r = run('base', { cadence: 'quarterly' })
    const detail = scenarioDetail(r, { showCarry: true })
    expect(detail.investorFlows.map(b => b.cadence)).toEqual(['annual', 'quarterly'])
    render(wrap(<InvestorFlowBlocks blocks={detail.investorFlows} />))
    expect(screen.getByText('Annual distributions (pack convention)')).toBeTruthy()
    expect(screen.getByText('Quarterly distributions')).toBeTruthy()
    expect(document.querySelector('[data-cadence="annual"] [data-multiple]')!.textContent).toBe('2.02x')
    expect(document.querySelector('[data-cadence="quarterly"] [data-irr]')!.textContent).toMatch(/%$/)
  })
})

describe('the page', () => {
  /** A fetch that answers the scenarios route from a queue and the plan route with the pack's Base. */
  function stubFetch(...scenarios: { status: number; body: unknown }[]) {
    const calls: { url: string; method: string; body: any }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.startsWith('/api/accounting/forecast/fleet-scenarios')) {
        const r = scenarios.shift() ?? { status: 200, body: response(true) }
        return new Response(JSON.stringify(r.body), { status: r.status })
      }
      return new Response(JSON.stringify({ plan: { id: planId('base'), name: 'Base case', revision: 3, fleet: packAssumptions('base') } }), { status: 200 })
    }))
    return calls
  }
  const EMPTY: FleetScenariosResponse = { results: {}, comparison: response(true).comparison, detail: null, cadence: null, primaryPlanId: null, plans: [], warnings: [] }

  it('unseeded: offers Create pitch scenarios, which POSTs { action: seed } and then shows the six', async () => {
    const calls = stubFetch({ status: 200, body: EMPTY }, { status: 200, body: { created: 6, plans: PLANS } }, { status: 200, body: response(true) })
    render(wrap(<ScenariosView vehicle="H200 SPV I" vehicleId="v1" />))
    const button = await screen.findByRole('button', { name: /Create pitch scenarios/ })
    fireEvent.click(button)
    await screen.findByText('Headline comparison')
    const post = calls.find(c => c.method === 'POST')!
    expect(post.url.split('?')[0]).toBe('/api/accounting/forecast/fleet-scenarios')
    expect(post.body).toMatchObject({ action: 'seed', group: 'H200 SPV I' })
    expect(headlineRow('investorMultiple')[0]).toBe('2.02x')
  })

  it('unseeded, without accounting write: the button is disabled and says why', async () => {
    stubFetch({ status: 200, body: EMPTY })
    render(wrap(<ScenariosView vehicle="H200 SPV I" vehicleId="v1" />, MEMBER_READ))
    const button = await screen.findByRole('button', { name: /Create pitch scenarios/ })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.getAttribute('title')).toBe('Creating the pitch scenarios needs write access to Accounting.')
  })

  it('a refused request is shown in the route’s words', async () => {
    stubFetch({ status: 403, body: { error: 'GPU fleet is switched off for this fund' } })
    render(wrap(<ScenariosView vehicle="H200 SPV I" vehicleId="v1" />))
    expect(await screen.findByText('GPU fleet is switched off for this fund')).toBeTruthy()
  })

  it('picking a scenario refetches its detail with ?plan= and puts it in the URL', async () => {
    const calls = stubFetch()
    render(wrap(<ScenariosView vehicle="H200 SPV I" vehicleId="v1" />))
    const pick = await screen.findByLabelText('Scenario')
    fireEvent.change(pick, { target: { value: planId('oversupply') } })
    await waitFor(() => expect(calls.some(c => c.url.includes(`plan=${planId('oversupply')}`))).toBe(true))
    expect(window.location.search).toContain(`plan=${planId('oversupply')}`)
  })

  it('exports the selected plan through the existing forecast export, with its months', async () => {
    stubFetch()
    window.history.replaceState(null, '', '/funds/v1/scenarios')
    render(wrap(<ScenariosView vehicle="H200 SPV I" vehicleId="v1" />))
    const link = await screen.findByRole('link', { name: /Export/ })
    expect(link.getAttribute('href')).toBe(scenarioExportHref('H200 SPV I', planId('base'), packAssumptions('base')))
    expect(link.getAttribute('href')).toBe(`/api/accounting/forecast/export?group=H200+SPV+I&plan=${planId('base')}&format=xlsx&start=2027-01&end=2031-12`)
  })

  it('renders the warnings under the table', async () => {
    stubFetch({ status: 200, body: { ...response(true), warnings: ['Base case: the register has no in-service assets'] } })
    render(wrap(<ScenariosView vehicle="H200 SPV I" vehicleId="v1" />))
    expect(await screen.findByText('Base case: the register has no in-service assets')).toBeTruthy()
  })
})

describe('the assumptions summary', () => {
  it('reads the plan’s fleet assumptions back, read-only', () => {
    render(wrap(<AssumptionsSummary fleet={packAssumptions('base')} />))
    expect(screen.getByText('2027-01')).toBeTruthy()
    expect(screen.getByText(/1 × h200_nvl \(8 GPUs, \$335,000\)/)).toBeTruthy()
    expect(screen.getByText('75%')).toBeTruthy()
    expect(screen.getByText('Annual distributions (pack convention)')).toBeTruthy()
  })
})

describe('the cell formatter', () => {
  it('formats by the row’s format, and a hidden figure is a dash', () => {
    const money = (n: number) => `$${n}`
    expect(formatReportValue(2.0234, 'multiple', money)).toBe('2.02x')
    expect(formatReportValue(-0.0518, 'pct', money)).toBe('-5.2%')
    expect(formatReportValue(2, 'year', money)).toBe('Year 2')
    expect(formatReportValue(null, 'year', money)).toBe('Not within life')
    expect(formatReportValue(null, 'usd', money)).toBe('—')
    expect(formatReportValue(null, 'usd', money, true)).toBe('—')
    expect(formatReportValue(1234, 'usd', money, true)).toBe('—')
  })
})

describe('the Forecast Fleet tab', () => {
  it('round-trips the pack’s assumptions through the form unchanged', () => {
    for (const id of IDS) {
      const a = packAssumptions(id)
      expect(fromFleetForm(toFleetForm(a)), id).toEqual({ fleet: a })
    }
  })

  it('round-trips per-type utilization, overrides, the register and a contingency return too', () => {
    const a = packAssumptions('base', {
      assets: 'register',
      utilization: { h200_nvl: [0.6, 0.65, 0.7, 0.75, 0.8], b200: [0.75, 0.75, 0.75, 0.75, 0.75], b300: [0.5, 0.55, 0.6, 0.65, 0.7] },
      overrides: { feeRate: 0.04, prefRate: 0.07, carryRate: 0.25, rocLpShare: 0.9 },
      capex: { contingencyPct: 0.1, contingencySpent: 100_000, returnYear: 3 },
      cadence: 'quarterly',
    })
    expect(fromFleetForm(toFleetForm(a))).toEqual({ fleet: a })
  })

  it('refuses what the form cannot read, by field', () => {
    expect(fromFleetForm({ ...toFleetForm(packAssumptions('base')), startMonth: '2027-13' })).toEqual({ error: 'Start month must be YYYY-MM.' })
    expect(fromFleetForm({ ...toFleetForm(packAssumptions('base')), utilization: 'lots' })).toEqual({ error: 'Utilization must be a number.' })
  })

  it('saving sends { expectedRevision, fleet } as a PATCH and hands back the recompiled plan', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ plan: { id: 'p1', revision: 8 } }), { status: 200 })
    }
    const saved = vi.fn()
    const reload = vi.fn(async () => null)
    const fleet = packAssumptions('base')
    expect(await saveFleetPlan({ fetcher, planId: 'p1', revision: 7, fleet, reload, saved })).toBeNull()
    expect(calls[0].url).toBe('/api/accounting/forecast/p1')
    expect(calls[0].init?.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ expectedRevision: 7, fleet })
    expect(saved).toHaveBeenCalledWith({ plan: { id: 'p1', revision: 8 } })
    expect(reload).not.toHaveBeenCalled()
  })

  it('a stale-revision 409 reloads the plan and says so', async () => {
    const routeError = 'The plan changed since you loaded it (revision 7 is now 8). Reload and try again.'
    const fetcher = async () => new Response(JSON.stringify({ error: routeError }), { status: 409 })
    const reload = vi.fn(async () => null)
    const saved = vi.fn()
    const message = await saveFleetPlan({ fetcher, planId: 'p1', revision: 7, fleet: packAssumptions('base'), reload, saved })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(saved).not.toHaveBeenCalled()
    expect(message).toBe(staleMessage(routeError))
    expect(message).toMatch(/latest assumptions have been loaded/)
  })

  it('another refusal (the engine’s input error) comes back in the route’s words, without a reload', async () => {
    const fetcher = async () => new Response(JSON.stringify({ error: 'saleYear must be between 1 and years' }), { status: 400 })
    const reload = vi.fn(async () => null)
    expect(await saveFleetPlan({ fetcher, planId: 'p1', revision: 7, fleet: packAssumptions('base'), reload, saved: () => {} }))
      .toBe('saleYear must be between 1 and years')
    expect(reload).not.toHaveBeenCalled()
  })

  it('the form, in a real DOM, saves exactly what it loaded, and shows a stale message', async () => {
    const fleet = packAssumptions('base')
    const onSave = vi.fn(async () => staleMessage('The plan changed since you loaded it.'))
    render(wrap(<FleetAssumptionsForm fleet={fleet} canEdit onSave={onSave} />))
    fireEvent.click(screen.getByRole('button', { name: 'Save fleet assumptions' }))
    expect(await screen.findByText(/The plan changed since you loaded it\. The latest assumptions have been loaded/)).toBeTruthy()
    expect(onSave).toHaveBeenCalledWith(fleet)
  })

  it('an edit reaches the save: utilization 75 becomes 80', async () => {
    const onSave = vi.fn(async (_fleet: FleetAssumptions) => null)
    render(wrap(<FleetAssumptionsForm fleet={packAssumptions('base')} canEdit onSave={onSave} />))
    fireEvent.change(screen.getByLabelText('Utilization, %'), { target: { value: '80' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save fleet assumptions' }))
    await screen.findByText('Saved. The plan has been recompiled.')
    expect(onSave.mock.calls[0][0]).toMatchObject({ utilization: 0.8 })
  })

  it('without write access the form is read-only', () => {
    render(wrap(<FleetAssumptionsForm fleet={packAssumptions('base')} canEdit={false} onSave={async () => null} />))
    expect((screen.getByLabelText('Utilization, %') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Save fleet assumptions' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the lead page’s Base case tiles', () => {
  it('take the primary scenario’s annual investor IRR and multiple', () => {
    const base = baseCaseReturns(response(true))!
    expect(base.name).toBe('Base case')
    expect(formatReportValue(base.multiple, 'multiple', () => '')).toBe('2.02x')
    expect(formatReportValue(base.irr, 'pct', () => '')).toBe('33.6%')
  })

  it('stay a dash with no scenarios, and the request names its vehicle', async () => {
    expect(baseCaseReturns({ results: {}, plans: [], primaryPlanId: null })).toBeNull()
    const calls: string[] = []
    await getVehicleScenarios(async url => { calls.push(url); return new Response('{}') }, 'H200 SPV I')
    expect(calls).toEqual(['/api/accounting/forecast/fleet-scenarios?group=H200%20SPV%20I'])
  })
})
