import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseRegisterSheet } from '@/lib/accounting/register-sheet'
import { normalizeSecurityType } from '@/lib/accounting/soi'

/**
 * The downloadable templates in public/templates must read as the importers expect. The register
 * is parsed deterministically, so it goes through the real parser. The LP and investments imports
 * are AI-mapped, so for those the headers are pinned against the fields the prompt names — a
 * template whose columns drift from the prompt would still "work" until the model guessed wrong.
 */

const root = process.cwd()
const template = (name: string) => readFileSync(join(root, 'public/templates', name), 'utf8')
const rows = (csv: string) => csv.trim().split(/\r?\n/).map(l => l.split(','))
const source = (p: string) => readFileSync(join(root, p), 'utf8')

describe('templates are clearly fictional and well-formed', () => {
  for (const name of ['lp-import.csv', 'investments-import.csv', 'capital-call-register.csv']) {
    it(name, () => {
      const [header, ...body] = rows(template(name))
      expect(body.length).toBeGreaterThanOrEqual(2)
      expect(body.length).toBeLessThanOrEqual(3)
      for (const r of body) {
        expect(r).toHaveLength(header.length)
        expect(r[0]).toMatch(/^Example /)
      }
    })
  }
})

describe('capital-call-register.csv', () => {
  it('reads through parseRegisterSheet with every partner matched and paid amounts carried', () => {
    const partners = [
      { lpEntityId: 'e1', name: 'Example LP 1' },
      { lpEntityId: 'e2', name: 'Example LP 2' },
      { lpEntityId: 'gp', name: 'Example GP LLC' },
    ]
    const parsed = parseRegisterSheet(template('capital-call-register.csv'), partners)
    expect(parsed.error).toBeNull()
    expect(parsed.unmatched).toEqual([])
    expect(parsed.lines.map(l => [l.lpEntityId, l.amount, l.paid, l.paidOn])).toEqual([
      ['e1', 100000, 100000, '2026-07-15'],
      ['e2', 50000, 25000, '2026-07-20'],
      ['gp', 1000, 0, null],
    ])
  })
})

describe('lp-import.csv', () => {
  const header = rows(template('lp-import.csv'))[0]
  const prompt = source('lib/lp-import/parse.ts')

  it('has the columns the LP importer maps', () => {
    expect(header).toEqual(['Investor', 'Entity', 'Vehicle', 'Commitment', 'Called', 'Distributions', 'NAV'])
  })

  it('every column names a field the prompt describes', () => {
    // Template header → the prompt's rule text that maps it.
    const rule: Record<string, RegExp> = {
      Investor: /investor_name: the LP name, investor name/,
      Entity: /entity_name: only include if there's a separate legal entity name column/,
      Vehicle: /portfolio_group: the fund name, vehicle name/,
      Commitment: /commitment: total capital commitment/,
      Called: /called_capital: capital called/,
      Distributions: /distributions: distributed capital, distributions received/,
      NAV: /nav: net asset value/,
    }
    for (const h of header) expect(prompt, h).toMatch(rule[h])
  })
})

describe('investments-import.csv', () => {
  const [header, ...body] = rows(template('investments-import.csv'))
  const prompt = source('app/api/import/investments/route.ts')

  it('every column maps to a field the prompt describes', () => {
    const field: Record<string, string> = {
      Company: 'company_name',
      Date: 'transaction_date',
      'Transaction type': 'transaction_type',
      Round: 'round_name',
      Cost: 'investment_cost',
      Shares: 'shares_acquired',
      'Share price': 'share_price',
      'Post-money': 'postmoney_valuation',
      Proceeds: 'proceeds_received',
      Vehicle: 'portfolio_group',
      'Security type': 'security_type',
    }
    for (const h of header) {
      expect(field[h], `unmapped header ${h}`).toBeDefined()
      expect(prompt).toContain(field[h])
    }
    // The headers the prompt maps by name, spelled as it spells them.
    for (const h of ['Cost', 'Shares', 'Share Price', 'Proceeds']) expect(prompt).toContain(`"${h}"`)
  })

  it('uses transaction types, dates and security types the importer accepts', () => {
    const at = (name: string) => header.indexOf(name)
    for (const r of body) {
      expect(['investment', 'proceeds', 'unrealized_gain_change', 'round_info']).toContain(r[at('Transaction type')].toLowerCase())
      expect(r[at('Date')]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(normalizeSecurityType(r[at('Security type')])).not.toBeNull()
    }
  })
})

describe('the import boxes link their templates', () => {
  it.each([
    ['app/(app)/lps/capital/view.tsx', '/templates/lp-import.csv'],
    ['app/(app)/import/page.tsx', '/templates/investments-import.csv'],
    ['app/(app)/funds/capital-accounts/view.tsx', '/templates/capital-call-register.csv'],
  ])('%s → %s', (file, href) => {
    expect(source(file)).toContain(`href="${href}"`)
  })
})
