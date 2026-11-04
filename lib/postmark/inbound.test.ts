import { describe, expect, it, vi } from 'vitest'
import { matchPostmarkInbound } from './inbound'

const acme = { fund_id: 'acme', postmark_inbound_address: 'acme@inbound.fund.example' }
const northwind = { fund_id: 'northwind', postmark_inbound_address: 'updates@northwind.inbound.fund.example' }
const shared = { fund_id: 'shared', postmark_inbound_address: 'abc123@inbound.postmarkapp.com' }

describe('matchPostmarkInbound', () => {
  it('matches the saved address, ignoring case, a display name and a +tag', () => {
    expect(matchPostmarkInbound('Acme@Inbound.Fund.example', [acme, northwind])?.fund_id).toBe('acme')
    expect(matchPostmarkInbound('Fund <acme+q3@inbound.fund.example>', [acme])?.fund_id).toBe('acme')
  })

  it('routes any other name at a fund\'s inbound domain to that fund', () => {
    expect(matchPostmarkInbound('receipts@inbound.fund.example', [acme, northwind])?.fund_id).toBe('acme')
    expect(matchPostmarkInbound('receipts@northwind.inbound.fund.example', [acme, northwind])?.fund_id).toBe('northwind')
  })

  it('does not treat a subdomain as its parent', () => {
    expect(matchPostmarkInbound('x@other.inbound.fund.example', [acme])).toBeNull()
  })

  it('on a domain two funds share, routes only their exact addresses', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const second = { fund_id: 'second', postmark_inbound_address: 'second@inbound.fund.example' }
    expect(matchPostmarkInbound('second@inbound.fund.example', [acme, second])?.fund_id).toBe('second')
    expect(matchPostmarkInbound('receipts@inbound.fund.example', [acme, second])).toBeNull()
  })

  it('keeps the exact address on Postmark\'s shared default domain, where the name is the server', () => {
    expect(matchPostmarkInbound('abc123@inbound.postmarkapp.com', [shared])?.fund_id).toBe('shared')
    expect(matchPostmarkInbound('abc123+x@inbound.postmarkapp.com', [shared])?.fund_id).toBe('shared')
    expect(matchPostmarkInbound('zzz999@inbound.postmarkapp.com', [shared])).toBeNull()
  })

  it('leaves the global inbound address to the global route', () => {
    expect(matchPostmarkInbound('all@inbound.fund.example', [acme], ['all@inbound.fund.example'])).toBeNull()
  })

  it('matches nothing for an empty or malformed recipient', () => {
    expect(matchPostmarkInbound('', [acme])).toBeNull()
    expect(matchPostmarkInbound('not-an-address', [acme])).toBeNull()
  })
})
