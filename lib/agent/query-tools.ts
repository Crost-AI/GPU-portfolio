// The query tools (query-tools-manifest.ts): load a dataset through its named tool's own loader,
// after checking that tool's access, then reshape it in memory (query/engine.ts).

import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { hasAccess } from '@/lib/access/effective'
import { DOMAIN_META } from '@/lib/access/domains'
import { QUERY_CATALOG } from './query/catalog'
import { QUERY_LOADERS } from './query/datasets'
import { runQuery } from './query/engine'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function handlerFor(tool: string): AgentToolHandler {
  const sets = QUERY_CATALOG[tool]
  return async (ctx: AgentToolContext, input: any) => {
    const ds = input?.dataset ? sets.find(d => d.name === input.dataset) : sets.length === 1 ? sets[0] : undefined
    if (!ds) throw new Error(`Pass a dataset: ${sets.map(d => d.name).join(', ')}.`)
    // The source tool's own access, including the switch it answers to: a dataset can't show more
    // than the tool its rows come from.
    if (!hasAccess(ctx.access, ds.gate.domain, 'read', ds.gate.feature)) {
      throw new Error(`The ${ds.name} dataset needs access to ${DOMAIN_META[ds.gate.domain].label}.`)
    }
    const asOf = input?.as_of ? String(input.as_of) : undefined
    if (asOf && !ISO_DATE.test(asOf)) throw new Error('as_of must be an ISO date (YYYY-MM-DD)')
    const rows = await QUERY_LOADERS[ds.name](ctx, { vehicle: input?.vehicle ? String(input.vehicle) : undefined, as_of: asOf })
    const result = runQuery(rows, ds.columns, input ?? {})
    return {
      dataset: ds.name,
      ...(ds.perVehicle ? { vehicle: ctx.portfolioGroup || input?.vehicle || null } : input?.vehicle ? { vehicle: input.vehicle } : {}),
      ...(asOf ? { as_of: asOf } : {}),
      ...result,
      ...(result.truncated ? { note: `Showing ${result.rows.length} rows. Narrow with where, group, or raise limit (up to 500).` } : {}),
    }
  }
}

export const QUERY_HANDLERS: Record<string, AgentToolHandler> = Object.fromEntries(
  Object.keys(QUERY_CATALOG).map(tool => [tool, handlerFor(tool)]),
)
