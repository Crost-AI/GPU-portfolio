import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkForUpdate } from './version'

/**
 * checkForUpdate sits on the admin layout's render path (getUpdateAvailable, on a cold cache), so
 * a GitHub API that never answers must not hold the page. The fetch carries a timeout; when it
 * fires, the existing catch turns it into null — "no update" — rather than a hung render.
 */
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('checkForUpdate', () => {
  it('gives up after 1.5s on a GitHub API that never answers', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    }))
    vi.stubGlobal('fetch', fetch)

    const started = Date.now()
    await expect(checkForUpdate()).resolves.toBeNull()

    expect(timeout).toHaveBeenCalledWith(1500)
    expect(Date.now() - started).toBeLessThan(4000)
    const init = fetch.mock.calls[0][1] as RequestInit & { next?: unknown }
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal?.aborted).toBe(true)
    // Still cached by Next for the hour.
    expect(init.next).toEqual({ revalidate: 3600 })
  }, 5000)

  it('still reports an update when GitHub answers in time', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tag_name: 'v999.0.0', html_url: 'https://github.test/r' })))
    await expect(checkForUpdate()).resolves.toMatchObject({ hasUpdate: true, latestVersion: '999.0.0' })
  })
})
