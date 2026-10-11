import { describe, it, expect, afterEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { cronAuthDenial, isValidCronAuthorization } from '@/lib/security/cron-auth'

const req = (auth?: string) => new Request('http://x/api/cron/x', { headers: auth ? { authorization: auth } : {} })
const original = process.env.CRON_SECRET
afterEach(() => {
  if (original === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = original
})

describe('cron auth', () => {
  it('accepts exactly Bearer <secret>', () => {
    expect(isValidCronAuthorization('Bearer s3cret', 's3cret')).toBe(true)
    expect(isValidCronAuthorization('Bearer s3cre', 's3cret')).toBe(false)
    expect(isValidCronAuthorization('Bearer s3cretX', 's3cret')).toBe(false)
    expect(isValidCronAuthorization('bearer s3cret', 's3cret')).toBe(false)
    expect(isValidCronAuthorization('s3cret', 's3cret')).toBe(false)
    expect(isValidCronAuthorization(null, 's3cret')).toBe(false)
  })

  it('fails closed when the secret is unset or empty — even for "Bearer " and "Bearer undefined"', () => {
    for (const secret of [undefined, null, '']) {
      expect(isValidCronAuthorization('Bearer ', secret)).toBe(false)
      expect(isValidCronAuthorization('Bearer undefined', secret)).toBe(false)
    }
    delete process.env.CRON_SECRET
    expect(cronAuthDenial(req('Bearer undefined'))?.status).toBe(500)
  })

  it('denies 401 on a wrong token and passes the right one', () => {
    process.env.CRON_SECRET = 'abc'
    expect(cronAuthDenial(req())?.status).toBe(401)
    expect(cronAuthDenial(req('Bearer abd'))?.status).toBe(401)
    expect(cronAuthDenial(req('Bearer abc'))).toBeNull()
  })

  it('every cron route uses the shared check, not a string compare', () => {
    const dir = path.join(__dirname, '..', 'app/api/cron')
    const routes = readdirSync(dir).map(d => path.join(dir, d, 'route.ts'))
    expect(routes.length).toBeGreaterThanOrEqual(8)
    for (const file of routes) {
      const src = readFileSync(file, 'utf8')
      expect(src, file).toContain('cronAuthDenial(req)')
      expect(src, file).not.toMatch(/!==\s*`Bearer/)
    }
  })
})
