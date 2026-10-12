// Which door a change came through: the web app, the API (agent REST and /api/v1), or MCP (Claude,
// ChatGPT and other assistants).
//
// Carried in async context rather than threaded through every signature, because the code that
// records an audit event is often several calls below the route that knows the door — a bank post
// from MCP reaches recordAudit through lib/accounting/bank-actions.ts, which the web bank page
// calls too. The route wraps its work once; every event recorded inside it carries the source.
// Nothing wraps a web route, so `web` is the default.

import { AsyncLocalStorage } from 'node:async_hooks'

export type ChangeSource = 'web' | 'api' | 'mcp'

export const CHANGE_SOURCES: readonly ChangeSource[] = ['web', 'api', 'mcp']

const store = new AsyncLocalStorage<ChangeSource>()

/** Run `fn` with every change recorded inside it attributed to `source`. */
export function withChangeSource<T>(source: ChangeSource, fn: () => T): T {
  return store.run(source, fn)
}

/** The source of the change being made now; `web` outside any wrapper. */
export function currentChangeSource(): ChangeSource {
  return store.getStore() ?? 'web'
}
