import { describe, it, expect } from 'vitest'
import { csvField, neutraliseCsvFormula, quoteCsvField } from './escape'

describe('neutraliseCsvFormula', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\t=1', '\r=1', '=HYPERLINK("https://x")'])(
    'prefixes an apostrophe on %j',
    s => expect(neutraliseCsvFormula(s)).toBe(`'${s}`),
  )

  it.each(['-12.50', '-5', '+3', '-41.67%', '-1e-7', '-.5', '12', 'plain', '', 'a=b', ' =1'])(
    'leaves %j alone',
    s => expect(neutraliseCsvFormula(s)).toBe(s),
  )
})

describe('quoteCsvField', () => {
  it('quotes only fields that need it', () => {
    expect(quoteCsvField('plain')).toBe('plain')
    expect(quoteCsvField('a,b')).toBe('"a,b"')
    expect(quoteCsvField('a"b')).toBe('"a""b"')
    expect(quoteCsvField('a\rb')).toBe('"a\rb"')
  })
})

describe('csvField', () => {
  it('neutralises before quoting, so the apostrophe sits inside the quotes', () => {
    expect(csvField('=1,2')).toBe(`"'=1,2"`)
    expect(csvField('=1')).toBe(`'=1`)
    expect(csvField('-12.50')).toBe('-12.50')
  })

  it('always quotes when asked', () => {
    expect(csvField('x', { alwaysQuote: true })).toBe('"x"')
    expect(csvField('@x', { alwaysQuote: true })).toBe(`"'@x"`)
    expect(csvField('say "hi"', { alwaysQuote: true })).toBe('"say ""hi"""')
  })
})
