import { describe, it, expect } from 'vitest'
import { pickLetterhead, fundLetterhead, safeLogo, type VehicleLetterhead } from './vehicle-letterhead'

const FUND = fundLetterhead({ name: 'Laconia', logo_url: 'data:image/png;base64,FUND', address: '1 Main St' })
const THREE_SE: VehicleLetterhead = { logo: 'data:image/png;base64,3SE', name: '3SE Holdings', address: '2 Elm St' }
const vehicles = new Map<string, VehicleLetterhead>([
  ['3SE Holdings LP', THREE_SE],
  ['3SE Holdings II LP', THREE_SE],
  ['3SE Fund I', THREE_SE], // an alias of 3SE Holdings LP
  ['Logo Only SPV', { logo: 'data:image/png;base64,SPV', name: null, address: null }],
])

describe('pickLetterhead', () => {
  it("uses a vehicle's own letterhead on a document about that vehicle", () => {
    expect(pickLetterhead(FUND, ['3SE Holdings LP'], vehicles)).toEqual(THREE_SE)
    expect(pickLetterhead(FUND, ['3SE Fund I'], vehicles)).toEqual(THREE_SE)
  })

  it('falls back to the fund for a vehicle without one', () => {
    expect(pickLetterhead(FUND, ['Fund I'], vehicles)).toEqual(FUND)
  })

  it('falls back part by part, so a logo-only vehicle keeps the fund name and address', () => {
    expect(pickLetterhead(FUND, ['Logo Only SPV'], vehicles)).toEqual({ logo: 'data:image/png;base64,SPV', name: 'Laconia', address: '1 Main St' })
  })

  it('uses vehicle values across vehicles only when they all share them', () => {
    expect(pickLetterhead(FUND, ['3SE Holdings LP', '3SE Holdings II LP', '3SE Holdings LP'], vehicles)).toEqual(THREE_SE)
    expect(pickLetterhead(FUND, ['3SE Holdings LP', 'Fund I'], vehicles)).toEqual(FUND)
  })

  it('uses the fund for a document with no vehicle', () => {
    expect(pickLetterhead(FUND, [], vehicles)).toEqual(FUND)
  })

  it('never returns a remote logo URL, which headless Chrome cannot render', () => {
    expect(fundLetterhead({ name: 'X', logo_url: 'https://example.com/logo.png' }).logo).toBeNull()
    expect(safeLogo('https://example.com/logo.png')).toBeNull()
  })
})
