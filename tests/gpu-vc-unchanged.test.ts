import { describe, it, expect } from 'vitest'

/**
 * ── GPU fleet (P5) ── Nothing VC moved. Every list below is a literal, captured from `main` @
 * d0f0fe5f before the P5 shells existed, so a reviewer can read it and see what a VC fund gets.
 * A GPU entry turning up in any of them fails here.
 */

import { navSectionsFor, fundsChildrenFor } from '@/components/app-sidebar'
import { effectiveAccess, type AccessContext } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureKey, type FeatureVisibilityMap } from '@/lib/types/features'
import type { Domain } from '@/lib/access/domains'
import { kindOptionsFor } from '@/lib/vehicle-kinds'
import { forecastTabsFor } from '@/app/(app)/funds/forecast/view'

// Every product on except GPU Operations, which a VC fund does not have.
const features = Object.fromEntries(
  Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, k === 'gpu_fleet' ? 'off' : 'everyone']),
) as FeatureVisibilityMap
const admin = { fundId: 'f', userId: 'u', role: 'admin', vehicles: { all: true, ids: [] }, features, grants: {}, defaults: {} } as AccessContext
const access = (d: Domain, f?: FeatureKey) => effectiveAccess(admin, d, f)
const kids = (kind: string | null, seg: string | null = 'SEG') => fundsChildrenFor(seg, false, kind).map(c => c.href)

const FUND_CHILDREN = [
  '/funds/SEG', '/funds/SEG/status', '/funds/SEG/bank', '/funds/SEG/receipts', '/funds/SEG/capital-accounts',
  '/funds/SEG/journal', '/funds/SEG/ledger', '/funds/SEG/periods', '/funds/SEG/schedule-of-investments',
  '/funds/SEG/performance', '/funds/SEG/forecast', '/funds/SEG/statements', '/funds/SEG/tax',
]

describe('a VC fund after the GPU shells', () => {
  it('sidebar: the same sections for an admin with every VC product on', () => {
    expect(navSectionsFor(true, access).map(i => i.href)).toEqual([
      '/start', '/getting-started', '/emails', '/deals', '/diligence', '/dashboard', '/lps', '/funds', '/usage', '/settings', '/support',
    ])
  })

  it('entity subnav: a fund and an SPV', () => {
    expect(kids('fund')).toEqual(FUND_CHILDREN)
    expect(kids('spv')).toEqual(FUND_CHILDREN)
  })

  it('entity subnav: a management company', () => {
    expect(kids('manco')).toEqual([
      '/funds/SEG', '/funds/SEG/status', '/funds/SEG/bank', '/funds/SEG/receipts', '/funds/SEG/journal',
      '/funds/SEG/ledger', '/funds/SEG/periods', '/funds/SEG/forecast', '/funds/SEG/statements',
    ])
  })

  it('firm-wide subnav', () => {
    expect(kids(null, null)).toEqual([
      '/funds/status', '/funds/bank', '/funds/receipts', '/funds/capital-accounts', '/funds/journal', '/funds/ledger',
      '/funds/periods', '/funds/schedule-of-investments', '/funds/performance', '/funds/forecast', '/funds/statements', '/funds/tax',
    ])
  })

  it('Add vehicle offers no GPU SPV to someone who cannot write the fleet', () => {
    expect(kindOptionsFor(false).map(o => o.value)).toEqual(['fund', 'spv', 'direct', 'associate', 'individual', 'manco', 'other'])
  })

  it('Forecast tabs per kind', () => {
    for (const kind of ['fund', 'spv', 'direct', 'associate', 'individual', 'other', null]) {
      expect(forecastTabsFor(kind), String(kind)).toEqual(['charts', 'investments', 'capital', 'financials'])
    }
    expect(forecastTabsFor('manco')).toEqual(['charts', 'financials', 'capital'])
  })
})
