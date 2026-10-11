// The Analyst's edit to an entity link (the page's settings → Entity links): which fund pays which
// management company its management fee, on what billing cycle. Staged, then applied through the
// forecast service — the same write the dialog makes.

import { listFeeLinks, saveFeeLink, type SaveFeeLinkInput } from '@/lib/forecast/service'
import type { ActionDeps, PreviewResult } from './types'

export interface SetEntityLinkInput extends Omit<SaveFeeLinkInput, 'manco'> {
  /** The management company. */
  vehicle: string
  explanation?: string
}

const ctxOf = (deps: ActionDeps) => ({ admin: deps.admin, fundId: deps.fundId, userId: deps.userId, access: deps.access })

export async function previewSetEntityLink(deps: ActionDeps, input: SetEntityLinkInput): Promise<PreviewResult> {
  if (!input?.vehicle || !input?.fund) throw new Error('vehicle (the management company) and fund are required')
  const links = await listFeeLinks(ctxOf(deps), { vehicle: input.vehicle })
  const current = (links.links as any[]).find(l => l.fund === input.fund) ?? null
  const after = {
    everyMonths: input.everyMonths ?? current?.everyMonths ?? 3,
    anchorMonth: input.anchorMonth ?? current?.anchorMonth ?? 1,
    direction: input.direction ?? current?.direction ?? 'advance',
    cashLagMonths: input.cashLagMonths ?? current?.cashLagMonths ?? 0,
    active: input.active ?? current?.active ?? true,
  }
  return {
    summary: `${current ? 'Change' : 'Add'} the entity link: ${input.fund} pays ${input.vehicle} its management fee`,
    details: { vehicle: input.vehicle, fund: input.fund, before: current, after, ...(input.explanation ? { explanation: input.explanation } : {}) },
  }
}

export async function executeSetEntityLink(deps: ActionDeps, input: SetEntityLinkInput): Promise<Record<string, unknown>> {
  const { vehicle, explanation: _explanation, ...rest } = input
  void _explanation
  const link = await saveFeeLink(ctxOf(deps), { ...rest, manco: vehicle })
  return { link }
}
