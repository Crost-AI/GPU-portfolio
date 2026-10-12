import { readFile } from 'node:fs/promises'
import type { Connector, JournalTransaction } from '../types.js'

/**
 * The smallest possible connector: journal transactions from a JSON file
 * (EXAMPLE_JOURNAL_FILE, default data/journal.example.json).
 *
 * Copy this to start your own. Replace the file read with calls to your source (its REST API, or
 * its MCP server through ../mcp-source.ts), keep yielding JournalTransaction batches, and the
 * runner does the rest: windowing, batching, idempotent import, review holds, the cursor.
 */
export const exampleFile: Connector = {
  id: 'example-file',
  source: 'quickbooks',
  description: 'Journal transactions from a local JSON file. A starting point, not a real source.',
  async *pull({ window, log }) {
    const path = process.env.EXAMPLE_JOURNAL_FILE || 'data/journal.example.json'
    const all = JSON.parse(await readFile(path, 'utf8')) as JournalTransaction[]
    const inWindow = all.filter(t => t.date >= window.from && t.date <= window.to)
    log(`read ${all.length} from ${path}, ${inWindow.length} in window`)
    yield inWindow
  },
}
