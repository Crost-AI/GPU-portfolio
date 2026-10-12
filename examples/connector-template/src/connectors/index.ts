import type { Connector } from '../types.js'
import { exampleFile } from './example-file.js'

/**
 * Every connector this repo can run, by id. Add yours here.
 *
 * In a private copy of this template this is where your real connectors go (QuickBooks, Carta,
 * anything else). None of it needs to exist in the Portfolio repo: the app only sees an API key
 * calling its MCP tools.
 */
export const CONNECTORS: Record<string, Connector> = {
  [exampleFile.id]: exampleFile,
}
