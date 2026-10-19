import { describe, it, expect } from 'vitest'
import { NO_CARRY, type VehicleCarryTerms } from './carry'
import { splitDistribution } from './distribution-waterfall'

// The fund waterfalls' output, pinned before the distributable_cash branch was added, so that
// branch provably leaves the VC path byte-for-byte: same lines, same cent placement (round-each,
// last recipient absorbs), same tiers and states.

const recipients = [{ lpEntityId: 'gp1', pct: 33.33 }, { lpEntityId: 'gp2', pct: 33.33 }, { lpEntityId: 'gp3', pct: 33.34 }]
const terms: Record<string, VehicleCarryTerms> = {
  european: { ...NO_CARRY, kind: 'european', carryRate: 0.2, prefRate: 0.08, catchupRate: 1, prefCompounds: true, gpEntityId: null, recipients },
  american: { ...NO_CARRY, kind: 'american', carryRate: 0.2, prefRate: 0.08, catchupRate: 0.8, prefCompounds: false, gpEntityId: null, recipients },
  straight: { ...NO_CARRY, kind: 'straight', carryRate: 0.25, gpEntityId: null, recipients },
}
const partners = [
  { lpEntityId: 'a', contributed: 333_333.33, distributed: 0, ending: 400_000 },
  { lpEntityId: 'b', contributed: 666_666.67, distributed: 0, ending: 800_000 },
  { lpEntityId: 'c', contributed: 1_000, distributed: 0, ending: 1_000.01 },
]
const contributions = [
  { date: '2024-01-15', amount: 333_333.33 }, { date: '2024-03-31', amount: 666_666.67 }, { date: '2025-02-28', amount: 1_000 },
]
const priors = [{ date: '2025-06-30', amount: 250_000.03 }, { date: '2026-01-31', amount: 800_000.07 }]

describe('VC splitDistribution output is unchanged', () => {
  for (const [kind, t] of Object.entries(terms)) {
    for (const total of [0.07, 1_000.01, 123_456.78, 2_000_000.05]) {
      it(`${kind} on ${total}`, () => {
        expect(splitDistribution({ total, terms: t, partners, contributions, priors, asOf: '2026-06-30', carryPaidToDate: 10 })).toMatchSnapshot()
      })
    }
  }
})
