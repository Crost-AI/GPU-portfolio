import { describe, it, expect } from 'vitest'
import { vendorKey, startingAllocationBasis } from './allocation-basis'

describe('vendorKey', () => {
  it('matches a vendor however its name was typed', () => {
    expect(vendorKey('ACME Legal, LLP')).toBe(vendorKey('acme  legal llp'))
    expect(vendorKey(null)).toBe('')
  })
})

describe('startingAllocationBasis', () => {
  const rules = new Map([[vendorKey('Acme Legal LLP'), 'Pro rata by commitment']])
  it('takes the receipt’s basis first', () => {
    expect(startingAllocationBasis(' 100% Fund I ', 'Acme Legal LLP', rules)).toEqual({ allocationBasis: '100% Fund I', allocationSource: 'receipt' })
  })
  it('falls back to the basis saved for the vendor', () => {
    expect(startingAllocationBasis('', 'ACME Legal, LLP', rules)).toEqual({ allocationBasis: 'Pro rata by commitment', allocationSource: 'vendor' })
  })
  it('has none for a vendor nobody saved', () => {
    expect(startingAllocationBasis(null, 'Northwind Travel', rules)).toEqual({ allocationBasis: null, allocationSource: null })
  })
})
