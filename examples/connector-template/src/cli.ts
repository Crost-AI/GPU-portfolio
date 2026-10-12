import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { CONNECTORS } from './connectors/index.js'
import { PortfolioClient } from './portfolio.js'
import { FileStateStore } from './state.js'
import { resolveWindow, runSync } from './sync.js'
import type { JournalTransaction } from './types.js'

// npm run sync     -- <connector> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run] [--review-token T]
// npm run accounts -- <connector> [--from ...] [--to ...]   → writes mappings/<connector>.json to review
// npm run map      -- <connector> --apply mappings/<connector>.json
// npm run login    -- <connector>

try { process.loadEnvFile() } catch { /* no .env: rely on the real environment */ }

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string' }, to: { type: 'string' },
    'dry-run': { type: 'boolean' }, 'review-token': { type: 'string' },
    apply: { type: 'string' },
  },
})
const [command, id] = positionals
const log = (m: string) => console.log(m)

async function main() {
  const connector = CONNECTORS[id ?? '']
  if (!command || !connector) {
    console.error(`Usage: <sync|accounts|map|login> <connector>\nConnectors: ${Object.keys(CONNECTORS).join(', ')}`)
    process.exit(2)
  }
  const state = new FileStateStore(connector.id)

  if (command === 'login') {
    if (!connector.login) { log(`${connector.id} needs no sign-in.`); return }
    await connector.login({ state, log })
    return
  }

  const portfolio = PortfolioClient.fromEnv()
  try {
    if (command === 'sync') {
      const s = await runSync(connector, portfolio, state, {
        window: { from: values.from, to: values.to }, dryRun: values['dry-run'], reviewToken: values['review-token'], log,
      })
      if (s.reviewRequired) {
        log(`\nHELD FOR REVIEW: nothing from this batch on was written. Differences:\n${s.reviewRequired.differences.map(d => `  - ${d}`).join('\n')}`)
        log(`\nIf they are expected, re-run with --review-token ${s.reviewRequired.token}`)
        process.exitCode = 3
        return
      }
      log(`\n${s.sent} sent in ${s.batches} batch(es): ${s.created} new drafts, ${s.alreadyPresent} already imported, ${s.skipped} skipped.`)
      for (const e of s.errors) log(`  ! ${e}`)
      for (const w of s.capitalWarnings) log(`  ~ ${w}`)
      if (s.skipped) log(`\nSkipped transactions are usually unmapped accounts: npm run accounts -- ${connector.id}`)
      return
    }

    if (command === 'accounts') {
      const window = await resolveWindow(state, { from: values.from, to: values.to })
      const txns: JournalTransaction[] = []
      for await (const page of connector.pull({ window, state, log })) txns.push(...page)
      const { accounts, errors } = await portfolio.accounts(connector.source, txns)
      for (const e of errors) log(`  ! ${e}`)
      const open = accounts.filter(a => a.confidence !== 'exact')
      for (const a of accounts) log(`${a.confidence === 'exact' ? '✓' : '?'} ${a.qbAccount} → ${a.excluded ? '(excluded)' : a.code ?? '—'}  ${a.reason}`)
      if (!open.length) { log('\nEvery account is mapped.'); return }
      await mkdir('mappings', { recursive: true })
      const file = `mappings/${connector.id}.json`
      // Proposals only. A person reviews this file; nothing is saved until `map --apply`.
      await writeFile(file, JSON.stringify(open.map(a => ({ qbAccount: a.qbAccount, accountCode: a.code, excluded: false, note: a.reason })), null, 2))
      log(`\n${open.length} account(s) need a decision. Review ${file} (set accountCode, or excluded: true), then:\n  npm run map -- ${connector.id} --apply ${file}`)
      return
    }

    if (command === 'map') {
      if (!values.apply) throw new Error('--apply <file> is required')
      const rows = JSON.parse(await readFile(values.apply, 'utf8'))
      const { saved } = await portfolio.saveMapping(connector.source, rows)
      log(`Saved ${saved} mapping(s). Run sync again; the skipped transactions will import.`)
      return
    }

    throw new Error(`Unknown command ${command}`)
  } finally {
    await portfolio.close()
  }
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
