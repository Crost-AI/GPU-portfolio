import { describe, expect, it } from 'vitest'
import { codeLandingDestination, isRecoveryLanding } from '@/lib/auth/code-landing'

/**
 * /auth exchanges a landing `?code=` and then decides where to go. Recovery is the flow that sent
 * the link (next=/auth/reset-password or type=recovery), not `recovery_sent_at`, which GoTrue also
 * sets on a magic-link sign-in of an existing user.
 */
const land = (o: Partial<Parameters<typeof codeLandingDestination>[0]> = {}) =>
  codeLandingDestination({ next: null, recovery: false, hasFund: true, mfaPending: false, ...o })

describe('isRecoveryLanding', () => {
  it('is the recovery flow only when the link says so', () => {
    expect(isRecoveryLanding('/auth/reset-password', null)).toBe(true)
    expect(isRecoveryLanding(null, 'recovery')).toBe(true)
    expect(isRecoveryLanding(null, null)).toBe(false)
    expect(isRecoveryLanding('/', 'magiclink')).toBe(false)
    expect(isRecoveryLanding('/auth/reset-password/x', null)).toBe(false)
  })
})

describe('codeLandingDestination', () => {
  it('magic link: next, else /', () => {
    expect(land()).toBe('/')
    expect(land({ next: '/portfolio' })).toBe('/portfolio')
  })

  it('recovery: the reset page, whatever next is', () => {
    expect(land({ recovery: true })).toBe('/auth/reset-password')
    expect(land({ recovery: true, next: '/portfolio' })).toBe('/auth/reset-password')
  })

  it('no fund: onboarding, except for a recovery', () => {
    expect(land({ hasFund: false })).toBe('/onboarding?confirmed=true')
    expect(land({ hasFund: false, next: '/oauth/authorize?client_id=x' })).toBe('/onboarding?confirmed=true')
    expect(land({ hasFund: false, recovery: true })).toBe('/auth/reset-password')
  })

  it('MFA pending: verify first, then the destination', () => {
    expect(land({ mfaPending: true })).toBe('/auth/mfa-verify?next=%2F')
    expect(land({ mfaPending: true, recovery: true })).toBe('/auth/mfa-verify?next=%2Fauth%2Freset-password')
    expect(land({ mfaPending: true, hasFund: false })).toBe('/auth/mfa-verify?next=%2Fonboarding%3Fconfirmed%3Dtrue')
  })

  it('regression: a user with recovery_sent_at set but no recovery intent lands on /, not the reset page', () => {
    // The magic-link landing on prod: GoTrue had set recovery_sent_at, the link carried no recovery intent.
    const user = { recovery_sent_at: '2026-10-18T22:11:51Z' }
    expect(user.recovery_sent_at).toBeTruthy()
    expect(land({ recovery: isRecoveryLanding(null, null) })).toBe('/')
  })
})
