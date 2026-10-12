import { describe, it, expect } from 'vitest'
import { pickDocumentLogo, safeLogo } from './vehicle-logo'

const FUND = 'data:image/png;base64,FUND'
const THREE_SE = 'data:image/png;base64,3SE'
const logos = new Map([
  ['3SE Holdings LP', THREE_SE],
  ['3SE Holdings II LP', THREE_SE],
  ['3SE Fund I', THREE_SE], // an alias of 3SE Holdings LP
])

describe('pickDocumentLogo', () => {
  it("uses a vehicle's own logo on a document about that vehicle", () => {
    expect(pickDocumentLogo(FUND, ['3SE Holdings LP'], logos)).toBe(THREE_SE)
    expect(pickDocumentLogo(FUND, ['3SE Fund I'], logos)).toBe(THREE_SE)
  })

  it('falls back to the fund logo for a vehicle without one', () => {
    expect(pickDocumentLogo(FUND, ['Fund I'], logos)).toBe(FUND)
  })

  it('uses the vehicle logo across vehicles only when they all share it', () => {
    expect(pickDocumentLogo(FUND, ['3SE Holdings LP', '3SE Holdings II LP', '3SE Holdings LP'], logos)).toBe(THREE_SE)
    expect(pickDocumentLogo(FUND, ['3SE Holdings LP', 'Fund I'], logos)).toBe(FUND)
  })

  it('never returns a remote URL, which headless Chrome cannot render', () => {
    expect(pickDocumentLogo('https://example.com/logo.png', ['Fund I'], logos)).toBeNull()
    expect(safeLogo('https://example.com/logo.png')).toBeNull()
  })

  it('uses the fund logo for a document with no vehicle', () => {
    expect(pickDocumentLogo(FUND, [], logos)).toBe(FUND)
  })
})
