import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { StateStore } from './types.js'

/**
 * State kept between runs, one JSON file per connector under CONNECTOR_STATE_DIR (default .state/).
 *
 * It holds the sync cursor and, for OAuth sources, the tokens, including refresh tokens that
 * ROTATE on every use (QuickBooks does this). Losing the newest one means signing in again, so the
 * write is atomic: a temp file renamed over the old one, never a half-written file.
 *
 * A file is right for a laptop or a long-lived box. On an ephemeral runner (GitHub Actions, a
 * serverless cron) the directory is gone after the run: swap this class for one backed by
 * something durable (a secrets manager, a KV store, a private bucket). The interface is two methods.
 */
export class FileStateStore implements StateStore {
  private cache: Record<string, unknown> | null = null

  constructor(private readonly connectorId: string, private readonly dir = process.env.CONNECTOR_STATE_DIR || '.state') {}

  private get path() { return join(this.dir, `${this.connectorId}.json`) }

  private async load(): Promise<Record<string, unknown>> {
    if (this.cache) return this.cache
    try { this.cache = JSON.parse(await readFile(this.path, 'utf8')) }
    catch (e: any) { if (e?.code !== 'ENOENT') throw e; this.cache = {} }
    return this.cache!
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.load())[key] as T | undefined
  }

  async set<T>(key: string, value: T): Promise<void> {
    const data = await this.load()
    data[key] = value
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    await rename(tmp, this.path)
  }
}
