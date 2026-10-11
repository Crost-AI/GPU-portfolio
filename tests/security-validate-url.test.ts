import { describe, it, expect } from 'vitest'
import { validateOllamaUrl, validateOllamaUrlResolved } from '@/lib/validate-url'

/** SSRF filter for the user-supplied OpenAI-compatible / Ollama base URL. */

describe('validateOllamaUrl — literal hosts', () => {
  it.each([
    'http://localhost:11434',
    'http://127.0.0.1:11434',
    'http://[::1]:11434',
    'https://openrouter.ai/api/v1',
    'https://8.8.8.8/v1',
    'https://[2606:4700:4700::1111]/v1',
  ])('allows %s', url => {
    expect(validateOllamaUrl(url).ok).toBe(true)
  })

  it.each([
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5',
    'http://172.16.0.1',
    'http://192.168.1.1',
    'http://127.0.0.2',
    'http://0.0.0.0',
    'http://100.64.0.1',
    'http://2130706434/', // 127.0.0.2 as an integer — URL normalizes it
    'http://0xa9fea9fe/', // 169.254.169.254 in hex
    'http://[fe80::1]/',
    'http://[febf::1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::ffff:7f00:2]/',
    'http://[::]/',
    'http://[ff02::1]/',
    'file:///etc/passwd',
    'gopher://example.com',
    'not a url',
  ])('blocks %s', url => {
    expect(validateOllamaUrl(url).ok).toBe(false)
  })
})

describe('validateOllamaUrlResolved — DNS', () => {
  const resolver = (map: Record<string, string[]>) => async (host: string) => {
    const addrs = map[host]
    if (!addrs) throw new Error('ENOTFOUND')
    return addrs.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
  }

  it('refuses a public-looking hostname that resolves to a private address', async () => {
    const lookup = resolver({ 'internal.example': ['10.0.0.5'], 'meta.example': ['169.254.169.254'], 'v6.example': ['fd00::1'], 'lo.example': ['::1'] })
    for (const host of ['internal.example', 'meta.example', 'v6.example', 'lo.example']) {
      expect((await validateOllamaUrlResolved(`https://${host}/v1`, lookup)).ok, host).toBe(false)
    }
  })

  it('refuses when ANY of several records is private', async () => {
    const lookup = resolver({ 'mixed.example': ['93.184.216.34', '192.168.0.10'] })
    expect((await validateOllamaUrlResolved('https://mixed.example/v1', lookup)).ok).toBe(false)
  })

  it('refuses an unresolvable host', async () => {
    expect((await validateOllamaUrlResolved('https://nope.example/v1', resolver({}))).ok).toBe(false)
  })

  it('allows a host resolving only to public addresses, and skips DNS for literals and localhost', async () => {
    const lookup = resolver({ 'openrouter.ai': ['104.18.2.115', '2606:4700::6812:273'] })
    expect(await validateOllamaUrlResolved('https://openrouter.ai/api/v1', lookup)).toEqual({ ok: true, url: 'https://openrouter.ai/api/v1' })
    const never = async () => { throw new Error('should not resolve') }
    expect((await validateOllamaUrlResolved('http://localhost:11434', never)).ok).toBe(true)
    expect((await validateOllamaUrlResolved('https://8.8.8.8/v1', never)).ok).toBe(true)
  })
})
