import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * getChromeConfig off Vercel: a self-hosted container installs Chromium and says where with
 * CHROME_EXECUTABLE_PATH. It used to probe a fixed list first and throw "Chrome not found locally."
 * before ever reading the variable, so a Chromium anywhere else was unreachable.
 */

const existing = new Set<string>()
vi.mock('fs', () => {
  const existsSync = (p: string) => existing.has(p)
  return { existsSync, default: { existsSync } }
})

import { getChromeConfig } from './lp-report-pdf'

const ARGS = ['--no-sandbox', '--disable-setuid-sandbox']

describe('getChromeConfig (not on Vercel)', () => {
  beforeEach(() => {
    existing.clear()
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', '')
    vi.stubEnv('CHROME_EXECUTABLE_PATH', '')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('uses CHROME_EXECUTABLE_PATH when it exists, even with nothing at the probed paths', async () => {
    vi.stubEnv('CHROME_EXECUTABLE_PATH', '/opt/chromium/chrome')
    existing.add('/opt/chromium/chrome')
    await expect(getChromeConfig()).resolves.toEqual({ executablePath: '/opt/chromium/chrome', args: ARGS })
  })

  it('prefers CHROME_EXECUTABLE_PATH over a probed Chrome', async () => {
    vi.stubEnv('CHROME_EXECUTABLE_PATH', '/opt/chromium/chrome')
    existing.add('/opt/chromium/chrome')
    existing.add('/usr/bin/chromium')
    expect((await getChromeConfig()).executablePath).toBe('/opt/chromium/chrome')
  })

  it('falls back to the probe when CHROME_EXECUTABLE_PATH points at nothing', async () => {
    vi.stubEnv('CHROME_EXECUTABLE_PATH', '/nope/chrome')
    existing.add('/usr/bin/chromium')
    await expect(getChromeConfig()).resolves.toEqual({ executablePath: '/usr/bin/chromium', args: ARGS })
  })

  it('falls back to the probe when CHROME_EXECUTABLE_PATH is unset', async () => {
    existing.add('/usr/bin/google-chrome')
    expect((await getChromeConfig()).executablePath).toBe('/usr/bin/google-chrome')
  })

  it('still throws when neither the variable nor the probe finds a browser', async () => {
    await expect(getChromeConfig()).rejects.toThrow('Chrome not found locally.')
  })
})
