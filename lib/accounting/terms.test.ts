import { describe, it, expect } from 'vitest'
import { commitmentsAsOf, allocationWeights, resolveCommitmentMap, loadAllocationBasis, loadPartnerTerms, type PartnerTerms } from './terms'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { allocateAmount } from './allocation'

describe('commitmentsAsOf', () => {
  const events = [
    { lpEntityId: 'a', effectiveDate: '2025-01-01', amount: 600_000, kind: 'initial' },
    { lpEntityId: 'b', effectiveDate: '2025-01-01', amount: 400_000, kind: 'initial' },
    { lpEntityId: 'a', effectiveDate: '2026-03-01', amount: 200_000, kind: 'increase' },
    // A secondary: B transfers 100k of commitment to C.
    { lpEntityId: 'b', effectiveDate: '2026-06-01', amount: -100_000, kind: 'transfer_out' },
    { lpEntityId: 'c', effectiveDate: '2026-06-01', amount: 100_000, kind: 'transfer_in' },
  ]

  it('sums deltas up to the date', () => {
    const at2025 = commitmentsAsOf(events, '2025-12-31')
    expect(at2025.get('a')).toBe(600_000)
    expect(at2025.get('b')).toBe(400_000)
    expect(at2025.has('c')).toBe(false)
  })

  it('picks up an increase once it is effective', () => {
    expect(commitmentsAsOf(events, '2026-03-31').get('a')).toBe(800_000)
    expect(commitmentsAsOf(events, '2026-02-28').get('a')).toBe(600_000)
  })

  it('a transfer moves commitment without changing the fund total', () => {
    const before = commitmentsAsOf(events, '2026-05-31')
    const after = commitmentsAsOf(events, '2026-06-30')
    const total = (m: Map<string, number>) => Array.from(m.values()).reduce((s, v) => s + v, 0)

    expect(before.get('b')).toBe(400_000)
    expect(after.get('b')).toBe(300_000)
    expect(after.get('c')).toBe(100_000)
    expect(total(after)).toBe(total(before)) // 1,200,000 either way
  })

  it('with no date, returns the current commitment', () => {
    expect(commitmentsAsOf(events).get('b')).toBe(300_000)
  })
})

describe('allocationWeights', () => {
  const partners = [
    { lpEntityId: 'gp', basisAmount: 100_000 },
    { lpEntityId: 'a', basisAmount: 600_000 },
    { lpEntityId: 'b', basisAmount: 300_000 },
  ]

  it('with no terms, everyone participates on the basis', () => {
    const w = allocationWeights(partners, [], 'management_fee')
    expect(w).toEqual([
      { lpEntityId: 'gp', commitment: 100_000 },
      { lpEntityId: 'a', commitment: 600_000 },
      { lpEntityId: 'b', commitment: 300_000 },
    ])
  })

  it('excluding the GP REDISTRIBUTES the fee onto the LPs — it does not shrink it', () => {
    const terms: PartnerTerms[] = [
      { lpEntityId: 'gp', category: 'management_fee', participates: false, weightOverride: null, rateOverride: null },
    ]
    const w = allocationWeights(partners, terms, 'management_fee')
    expect(w.map(x => x.lpEntityId)).toEqual(['a', 'b'])

    // The full 100k fee still gets allocated — 2/3 to a, 1/3 to b.
    const split = allocateAmount(-100_000, w)
    expect(split.get('a')).toBe(-66_666.67)
    expect(split.get('b')).toBe(-33_333.33)
    expect(Array.from(split.values()).reduce((s, v) => s + v, 0)).toBeCloseTo(-100_000, 2)
    expect(split.has('gp')).toBe(false)
  })

  it('currency translation follows the terms for unrealized gains', () => {
    const terms: PartnerTerms[] = [
      { lpEntityId: 'gp', category: 'valuation', participates: false, weightOverride: null, rateOverride: null },
    ]
    expect(allocationWeights(partners, terms, 'fx_revaluation').map(x => x.lpEntityId)).toEqual(['a', 'b'])
  })

  it('terms are per category — the GP still bears expenses and still gets gains', () => {
    const terms: PartnerTerms[] = [
      { lpEntityId: 'gp', category: 'management_fee', participates: false, weightOverride: null, rateOverride: null },
    ]
    expect(allocationWeights(partners, terms, 'partnership_expense').map(x => x.lpEntityId)).toContain('gp')
    expect(allocationWeights(partners, terms, 'valuation').map(x => x.lpEntityId)).toContain('gp')
  })

  it('a weight override replaces that partner’s basis only', () => {
    const terms: PartnerTerms[] = [
      { lpEntityId: 'a', category: 'partnership_expense', participates: true, weightOverride: 50_000, rateOverride: null },
    ]
    const w = allocationWeights(partners, terms, 'partnership_expense')
    expect(w.find(x => x.lpEntityId === 'a')!.commitment).toBe(50_000)
    expect(w.find(x => x.lpEntityId === 'b')!.commitment).toBe(300_000) // untouched
  })

  it('drops partners with no basis amount', () => {
    const w = allocationWeights([{ lpEntityId: 'z', basisAmount: 0 }], [], 'income')
    expect(w).toEqual([])
  })
})

describe('resolveCommitmentMap', () => {
  const owners = [
    { lpEntityId: 'a', commitment: 1000 },
    { lpEntityId: 'b', commitment: 0 },
  ]
  const events = [
    { lpEntityId: 'a', effectiveDate: '2024-01-01', amount: 1000, kind: 'initial' },
    { lpEntityId: 'b', effectiveDate: '2024-06-01', amount: 5750, kind: 'increase' },
  ]

  it('prefers events over the scalar (the $0-vs-$5,750 case)', () => {
    // b has a $5,750 event but a $0 scalar — events must win.
    const m = resolveCommitmentMap({ source: 'ledger', owners, events })
    expect(m.get('a')).toBe(1000)
    expect(m.get('b')).toBe(5750)
  })

  it('falls back to the scalar when there are no events', () => {
    const m = resolveCommitmentMap({ source: 'ledger', owners, events: [] })
    expect(m.get('a')).toBe(1000)
    expect(m.get('b')).toBe(0)
  })

  it('honors asOf on the event ladder', () => {
    // b's event is dated 2024-06-01; as of 2024-03-01 it has not happened, so events are
    // a-only ($1000 > 0) and win — b resolves to 0 (no event yet, scalar not consulted
    // because events already have a positive value).
    const m = resolveCommitmentMap({ source: 'ledger', owners, events, asOf: '2024-03-01' })
    expect(m.get('a')).toBe(1000)
    expect(m.get('b') ?? 0).toBe(0)
  })

  it('lets positions override for a non-ledger (tracking) vehicle', () => {
    const positions = new Map([['a', 2500], ['b', 5750]])
    const m = resolveCommitmentMap({ source: 'events', owners, events, positions })
    expect(m.get('a')).toBe(2500) // position overrides the $1000 event
    expect(m.get('b')).toBe(5750)
  })

  it('uses available position commitments regardless of the former mode', () => {
    const positions = new Map([['a', 999999]])
    const m = resolveCommitmentMap({ source: 'ledger', owners, events, positions })
    expect(m.get('a')).toBe(999999)
  })

  it('ignores an empty positions map even for a tracking vehicle', () => {
    const m = resolveCommitmentMap({ source: 'events', owners, events, positions: new Map() })
    expect(m.get('b')).toBe(5750) // empty positions → base ladder
  })
})

describe('the settings loaders on a failed read', () => {
  const vehicles = { fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I' }] }

  // A failed read used to come back as the default — commitment basis, no side letters — and a
  // close on it still balanced, so nothing noticed the partners were allocated on the wrong terms.
  it('loadAllocationBasis rejects instead of defaulting to commitment', async () => {
    const m = memoryAdmin({ ...vehicles, vehicle_accounting_settings: [{ fund_id: 'f', vehicle_id: 'v1', allocation_basis: 'capital_balance' }] })
    m.failNext('vehicle_accounting_settings', 'select', 'boom')
    await expect(loadAllocationBasis(m.admin, 'f', 'Fund I')).rejects.toThrow(/boom/)
    expect(await loadAllocationBasis(m.admin, 'f', 'Fund I')).toBe('capital_balance')
  })

  it('loadAllocationBasis still defaults to commitment when no row exists', async () => {
    expect(await loadAllocationBasis(memoryAdmin(vehicles).admin, 'f', 'Fund I')).toBe('commitment')
  })

  it('loadPartnerTerms rejects instead of reading as no side letters', async () => {
    const m = memoryAdmin({ ...vehicles, partner_allocation_terms: [{ fund_id: 'f', vehicle_id: 'v1', lp_entity_id: 'a', category: 'management_fee', participates: false }] })
    m.failNext('partner_allocation_terms', 'select', 'boom')
    await expect(loadPartnerTerms(m.admin, 'f', 'Fund I')).rejects.toThrow(/boom/)
    expect(await loadPartnerTerms(m.admin, 'f', 'Fund I')).toHaveLength(1)
  })

  it('loadPartnerTerms still returns [] when there are no terms', async () => {
    expect(await loadPartnerTerms(memoryAdmin(vehicles).admin, 'f', 'Fund I')).toEqual([])
  })
})
