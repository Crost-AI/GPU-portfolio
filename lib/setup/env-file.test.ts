import { describe, it, expect } from 'vitest'
import { authConfigFor, parseEnv, supabaseKeysFromCli, updateEnv } from './env-file'

describe('parseEnv', () => {
  it('reads plain, quoted and exported values and skips comments', () => {
    expect(parseEnv('# c\nA=1\nexport B="two words"\nC=\'x\'\nD=val # note\n\nnot a line')).toEqual({ A: '1', B: 'two words', C: 'x', D: 'val' })
  })
})

describe('updateEnv', () => {
  it('rewrites existing keys in place, appends new ones and keeps everything else', () => {
    const before = '# Supabase\nNEXT_PUBLIC_SUPABASE_URL=\nKEEP=me\n'
    const after = updateEnv(before, { NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co', ENCRYPTION_KEY: 'f'.repeat(64), SKIP: undefined })
    expect(after).toBe(`# Supabase\nNEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co\nKEEP=me\nENCRYPTION_KEY=${'f'.repeat(64)}\n`)
  })

  it('quotes values that need it, and round-trips them', () => {
    const text = updateEnv('', { A: 'has space', B: 'x#y' })
    expect(parseEnv(text)).toEqual({ A: 'has space', B: 'x#y' })
  })
})

describe('supabaseKeysFromCli', () => {
  it('finds the anon and service-role keys, or gives up', () => {
    const k = (n: string) => ({ name: n, api_key: `${n}-${'x'.repeat(30)}` })
    expect(supabaseKeysFromCli([k('anon'), k('service_role')])).toEqual({ anon: k('anon').api_key, serviceRole: k('service_role').api_key })
    expect(supabaseKeysFromCli([k('anon')])).toBeNull()
    expect(supabaseKeysFromCli({})).toBeNull()
  })
})

describe('authConfigFor', () => {
  it('sets the site URL, the wildcard redirect and the signup hook, and keeps confirmations on', () => {
    expect(authConfigFor('https://r.fund.com/')).toMatchObject({
      site_url: 'https://r.fund.com',
      uri_allow_list: 'https://r.fund.com/**',
      mailer_autoconfirm: false,
      hook_before_user_created_enabled: true,
    })
  })
})
