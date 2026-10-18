import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * Every server-side auth redirect (and the approve route's self-call origin) uses the configured
 * public origin, not request.url's: behind the deploy/local proxy that is https://localhost:3000,
 * and a redirect there leaves the browser on a dead host after signing in.
 */
const s = vi.hoisted(() => ({
  user: null as { id: string } | null,
  exchangeError: null as { message: string } | null,
  membership: null as { fund_id: string } | null,
  approveOrigin: undefined as string | undefined,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: s.user } }),
      exchangeCodeForSession: async () => ({ error: s.exchangeError }),
      signOut: async () => ({ error: null }),
    },
  }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: s.membership }) }) }) }),
  }),
}))
vi.mock('@/lib/activity', () => ({ logActivity: () => {} }))
vi.mock('@/lib/cache/tags', () => ({ expireTag: () => {} }))
vi.mock('@/lib/pending-actions/browser-principal', () => ({ resolveBrowserPrincipal: async () => ({ userId: 'u', fundId: 'f' }) }))
vi.mock('@/lib/pending-actions/call-notices-publish', () => ({ executePublishCallNotices: async () => ({}) }))
vi.mock('@/lib/google/oauth-state', async (orig) => ({
  ...(await orig<typeof import('@/lib/google/oauth-state')>()),
  consumeGoogleOAuthTransaction: () => ({ codeVerifier: 'v', fundId: 'f', returnTo: '/portfolio/acme' }),
}))
vi.mock('@/lib/pending-actions/service', () => ({
  PendingActionServiceError: class extends Error { status = 400 },
  approvePendingAction: async (_a: unknown, _p: unknown, _id: string, opts: { origin?: string }) => {
    s.approveOrigin = opts.origin
    return { result: {}, replayed: false }
  },
}))

import { GET as callback } from '@/app/auth/callback/route'
import { GET as postLogin } from '@/app/auth/post-login/route'
import { POST as logout } from '@/app/api/auth/logout/route'
import { POST as approve } from '@/app/api/pending-actions/[id]/approve/route'
import { GET as googleCallback } from '@/app/api/auth/google/callback/route'

const BIND = 'http://localhost:3000'
const PUBLIC = 'https://cap.example.com'
const location = (res: Response) => res.headers.get('location')

describe('server-side auth redirects use NEXT_PUBLIC_SITE_URL, not the bind origin', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', PUBLIC)
    s.user = null; s.exchangeError = null; s.membership = null; s.approveOrigin = undefined
  })
  afterEach(() => vi.unstubAllEnvs())

  it('/auth/callback: a code exchange lands on next at the public origin', async () => {
    s.user = { id: 'u' }; s.membership = { fund_id: 'f' }
    expect(location(await callback(new NextRequest(`${BIND}/auth/callback?code=c&next=/auth/reset-password`))))
      .toBe(`${PUBLIC}/auth/reset-password`)
  })

  it('/auth/callback: a missing code and a failed exchange go to /auth at the public origin', async () => {
    expect(location(await callback(new NextRequest(`${BIND}/auth/callback`)))).toMatch(new RegExp(`^${PUBLIC}/auth\\?error=`))
    s.exchangeError = { message: 'expired' }
    expect(location(await callback(new NextRequest(`${BIND}/auth/callback?code=c`)))).toBe(`${PUBLIC}/auth?error=expired`)
  })

  it('/auth/post-login: signed in goes to next, signed out to /auth, both at the public origin', async () => {
    s.user = { id: 'u' }; s.membership = { fund_id: 'f' }
    expect(location(await postLogin(new NextRequest(`${BIND}/auth/post-login?method=magic_link&next=/`)))).toBe(`${PUBLIC}/`)
    s.user = null
    expect(location(await postLogin(new NextRequest(`${BIND}/auth/post-login`)))).toMatch(new RegExp(`^${PUBLIC}/auth\\?error=`))
  })

  it('/auth/post-login: a new user without a fund goes to onboarding at the public origin', async () => {
    s.user = { id: 'u' }
    expect(location(await postLogin(new NextRequest(`${BIND}/auth/post-login?next=/`)))).toBe(`${PUBLIC}/onboarding?confirmed=true`)
  })

  it('/api/auth/logout redirects to /auth at the public origin', async () => {
    expect(location(await logout(new Request(`${BIND}/api/auth/logout`, { method: 'POST' })))).toBe(`${PUBLIC}/auth`)
  })

  it('/api/pending-actions/[id]/approve hands staged tools the public origin', async () => {
    const res = await approve(new Request(`${BIND}/api/pending-actions/p/approve`, { method: 'POST', body: '{}' }), { params: Promise.resolve({ id: 'p' }) })
    expect(res.status).toBe(200)
    expect(s.approveOrigin).toBe(PUBLIC)
  })

  it('/api/auth/google/callback: signed out, a bad request and a returnTo all redirect at the public origin', async () => {
    expect(location(await googleCallback(new NextRequest(`${BIND}/api/auth/google/callback`)))).toBe(`${PUBLIC}/auth`)
    s.user = { id: 'u' }
    expect(location(await googleCallback(new NextRequest(`${BIND}/api/auth/google/callback`))))
      .toBe(`${PUBLIC}/settings?drive_error=missing_params`)
    vi.stubEnv('ENCRYPTION_KEY', 'k')
    expect(location(await googleCallback(new NextRequest(`${BIND}/api/auth/google/callback?state=s&error=access_denied`))))
      .toBe(`${PUBLIC}/portfolio/acme?drive_error=consent_denied`)
  })

  it('without NEXT_PUBLIC_SITE_URL, redirects stay on the request origin (next dev, previews)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(location(await logout(new Request(`${BIND}/api/auth/logout`, { method: 'POST' })))).toBe(`${BIND}/auth`)
  })
})
