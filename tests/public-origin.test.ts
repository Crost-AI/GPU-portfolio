import { afterEach, describe, expect, it, vi } from 'vitest'
import { publicOrigin } from '@/lib/public-origin'

/**
 * Under `next start` behind a proxy, request.url is Next's own bind origin (https://localhost:3000),
 * so redirects take the configured public origin instead, and fall back to request.url only where
 * none is configured (plain `next dev`, Vercel previews).
 */
const req = new Request('https://localhost:3000/auth/callback?code=x')

describe('publicOrigin', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is NEXT_PUBLIC_SITE_URL when set, path and trailing slash dropped', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://cap.example.com/')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://old.example.com')
    expect(publicOrigin(req)).toBe('https://cap.example.com')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://cap.example.com/some/path')
    expect(publicOrigin(req)).toBe('https://cap.example.com')
  })

  it('falls back to NEXT_PUBLIC_APP_URL, the older name', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://old.example.com')
    expect(publicOrigin(req)).toBe('https://old.example.com')
  })

  it("is the request's own origin when neither is set", () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(publicOrigin(new Request('http://localhost:3000/auth/callback'))).toBe('http://localhost:3000')
    expect(publicOrigin(new Request('https://preview-abc.vercel.app/x'))).toBe('https://preview-abc.vercel.app')
  })

  it("is the request's own origin under next dev, even with NEXT_PUBLIC_SITE_URL set (setup.ts writes it to .env.local)", () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://cap.example.com')
    expect(publicOrigin(new Request('http://localhost:3000/x'))).toBe('http://localhost:3000')
    vi.stubEnv('NODE_ENV', 'production')
    expect(publicOrigin(new Request('http://localhost:3000/x'))).toBe('https://cap.example.com')
  })

  it("is the request's own origin when the configured value is not a URL", () => {
    for (const site of ['cap.example.com', 'localhost:3000', 'cap.example.com:443', 'ftp://cap.example.com']) {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', site)
      expect(publicOrigin(new Request('http://localhost:3000/x'))).toBe('http://localhost:3000')
    }
  })
})
