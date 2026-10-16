import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

/**
 * Guards the "no real data" rule in CLAUDE.md: no client fund, LP, company or person names in
 * tracked files, and no links to Claude sessions. The names are stored as truncated SHA-256
 * hashes of lower-cased words so this list does not itself name anyone. To add one:
 * `printf %s word | shasum -a 256 | cut -c1-16`.
 */
const BLOCKED = new Set([
  '7b54a0535b2ef786', 'af945d6e008f94fb', '3ce91f9776b070e2', '154f8df05577f3d2',
  'ac811aa0c42fd2e1', 'caba271ff6056aba', 'a3d2e957eb7fa81f', '0312086a77487a5c',
  '59d0a590feb54083', '26235bdc3152aeb3', '82f0e147bae8c079', 'cdbb6c1d56bb863c',
  '7340b8f0d5a6fade', '0f84637df36e665c', 'aaefbc38622fd293', '35084a43186b4fed',
  'f36383328d9f791a', 'dc17f27c83d52979', '2339f2e23a26bfa7', '30325571d5ca9719',
])

const SKIP = /(^|\/)(package-lock\.json|vendor\/|public\/|demo-widget\/data\/)|\.(png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf|zip|tgz|xlsx)$/
const hash = (w: string) => createHash('sha256').update(w).digest('hex').slice(0, 16)

const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(f => f && !SKIP.test(f))
const textOf = (f: string) => {
  try { return statSync(f).size < 2_000_000 ? readFileSync(f, 'utf8') : '' } catch { return '' }
}

describe('no real client data in the repo', () => {
  it('names no blocked fund, company or person', () => {
    const hits: string[] = []
    for (const f of files) {
      const words = new Set(textOf(f).toLowerCase().match(/[a-z0-9]+/g) ?? [])
      for (const w of words) if (BLOCKED.has(hash(w))) hits.push(f)
    }
    expect(hits, 'replace real names with invented placeholders (see CLAUDE.md)').toEqual([])
  })

  it('links to no Claude session', () => {
    const hits = files.filter(f => /claude\.ai\/code\/session_/.test(textOf(f)))
    expect(hits).toEqual([])
  })
})
