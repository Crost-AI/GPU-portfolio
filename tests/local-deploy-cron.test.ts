import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * The self-hosted stack (deploy/local) has no Vercel to read vercel.json's `crons`; its scheduler
 * container runs deploy/local/cron/crontab instead. A cron added to vercel.json and not to the
 * crontab would simply never run on a self-hosted install, with nothing failing to say so.
 */

const root = process.cwd()
const read = (...p: string[]) => readFileSync(path.join(root, ...p), 'utf8')

const vercelCrons: { path: string; schedule: string }[] = JSON.parse(read('vercel.json')).crons

const crontab = read('deploy', 'local', 'cron', 'crontab')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'))
  .map(line => {
    const fields = line.split(/\s+/)
    return { schedule: fields.slice(0, 5).join(' '), command: fields.slice(5).join(' '), line }
  })
const crontabPath = (command: string) => command.match(/\/api\/cron\/[a-z0-9-]+/)?.[0]

const cronDir = path.join(root, 'app', 'api', 'cron')
const cronRoutes = readdirSync(cronDir).filter(d => statSync(path.join(cronDir, d)).isDirectory())

describe('deploy/local crontab mirrors vercel.json crons', () => {
  it('runs every line through run-cron against one /api/cron route', () => {
    for (const { command, line } of crontab) {
      expect(command, line).toMatch(/^run-cron \/api\/cron\/[a-z0-9-]+$/)
    }
  })

  it('has each vercel.json cron exactly once, on the identical schedule', () => {
    for (const cron of vercelCrons) {
      const matches = crontab.filter(e => crontabPath(e.command) === cron.path)
      expect(matches, cron.path).toHaveLength(1)
      expect(matches[0].schedule, cron.path).toBe(cron.schedule)
    }
  })

  it('has no entry that vercel.json does not', () => {
    const paths = new Set(vercelCrons.map(c => c.path))
    for (const { command, line } of crontab) expect(paths.has(crontabPath(command) ?? ''), line).toBe(true)
    expect(crontab).toHaveLength(vercelCrons.length)
  })

  it('covers every route under app/api/cron', () => {
    expect(cronRoutes.length).toBeGreaterThan(0)
    const scheduled = new Set(crontab.map(e => crontabPath(e.command)))
    for (const route of cronRoutes) expect(scheduled.has(`/api/cron/${route}`), route).toBe(true)
  })
})
