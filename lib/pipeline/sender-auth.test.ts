import { describe, it, expect } from 'vitest'
import { postmarkSenderVerified, resendSenderVerified } from './sender-auth'
import { authenticationRejection, matchInboundDomain } from '@/lib/resend/inbound'

const h = (Name: string, Value: string) => ({ Name, Value })

describe('postmarkSenderVerified — a member treatment needs more than a From header', () => {
  const POSTMARK_SPF_PASS = h('Received-SPF', 'Pass (sender SPF authorized) identity=mailfrom; envelope-from="gp@fund.example"; receiver=inbound.postmarkapp.com')

  it('accepts the topmost Received-SPF pass for an envelope sender aligned with From', () => {
    expect(postmarkSenderVerified('gp@fund.example', [POSTMARK_SPF_PASS])).toBe(true)
    expect(postmarkSenderVerified('gp@mail.fund.example', [h('Received-SPF', 'Pass identity=mailfrom; envelope-from="bounce@fund.example"')])).toBe(true)
  })

  it('refuses an unaligned envelope sender, an SPF that did not pass, and no headers at all', () => {
    expect(postmarkSenderVerified('gp@fund.example', [h('Received-SPF', 'Pass identity=mailfrom; envelope-from="x@attacker.example"')])).toBe(false)
    expect(postmarkSenderVerified('gp@fund.example', [h('Received-SPF', 'Softfail identity=mailfrom; envelope-from="gp@fund.example"')])).toBe(false)
    expect(postmarkSenderVerified('gp@fund.example', [])).toBe(false)
    expect(postmarkSenderVerified('gp@fund.example', undefined)).toBe(false)
  })

  // Crost #136 and Codex on #137: Authentication-Results can be the sender's own.
  it('never trusts Authentication-Results: a forged pass over Postmark\'s failing SPF is refused', () => {
    expect(postmarkSenderVerified('gp@fund.example', [
      h('Received-SPF', 'Fail (sender not authorized) identity=mailfrom; envelope-from="gp@fund.example"; receiver=inbound.postmarkapp.com'),
      h('Authentication-Results', 'attacker.invalid; dmarc=pass header.from=fund.example'),
    ])).toBe(false)
    expect(postmarkSenderVerified('gp@fund.example', [h('Authentication-Results', 'mx.example; dmarc=pass header.from=fund.example')])).toBe(false)
    expect(postmarkSenderVerified('gp@fund.example', [h('Authentication-Results', 'x; spf=fail (dmarc=pass) smtp.mailfrom=fund.example')])).toBe(false)
  })

  it('reads only the topmost Received-SPF: a pass the sender wrote below Postmark\'s fail does not count', () => {
    expect(postmarkSenderVerified('gp@fund.example', [
      h('Received-SPF', 'Fail identity=mailfrom; envelope-from="gp@fund.example"; receiver=inbound.postmarkapp.com'),
      POSTMARK_SPF_PASS,
    ])).toBe(false)
  })
})

describe('Resend', () => {
  it('a member treatment needs DMARC pass', () => {
    expect(resendSenderVerified({ dmarc: 'pass', spf: 'pass', dkim: 'pass' })).toBe(true)
    expect(resendSenderVerified({ dmarc: 'gray', spf: 'pass', dkim: 'pass' })).toBe(false)
    expect(resendSenderVerified(null)).toBe(false)
  })

  it('refuses mail that passed neither SPF nor DKIM, as well as a DMARC fail', () => {
    expect(authenticationRejection({ dmarc: 'gray', spf: 'gray', dkim: 'unknown' })).toMatch(/neither SPF nor DKIM/)
    expect(authenticationRejection({ dmarc: 'fail', spf: 'pass', dkim: 'fail' })).toMatch(/DMARC failed/)
    expect(authenticationRejection({ dmarc: 'gray', spf: 'pass', dkim: 'gray' })).toBeNull()
  })

  it('delivers to neither fund when two claim one inbound domain', () => {
    const settings = [{ fund_id: 'a', resend_inbound_domain: 'in.fund.example' }, { fund_id: 'b', resend_inbound_domain: 'IN.fund.example ' }]
    expect(matchInboundDomain(['x@in.fund.example'], settings)).toBeNull()
    expect(matchInboundDomain(['x@in.fund.example'], settings.slice(0, 1))?.settings.fund_id).toBe('a')
  })
})
