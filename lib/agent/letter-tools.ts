// The LP letter tools (letter-tools-manifest.ts). Each calls the function the LP Letters pages
// call (lib/lp-letters/service.ts), with the caller's visible entities, so a letter of an entity
// they can't see is not found here either.

import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { resolveVehicle } from '@/lib/accounting/vehicle-resolver'
import { unwrap } from '@/lib/service-outcome'
import { reportLinkUrl, signReportLink } from '@/lib/agent/report-links'
import { siteOrigin } from '@/lib/site-links'
import { createLetter, getLetter, letterData, listLetters, shareLetter, updateLetter, writeLetterSections } from '@/lib/lp-letters/service'
import { requireUser } from './deals-tools'
import { resolveInvestor } from './lp-record-tools'

async function visible(ctx: AgentToolContext): Promise<string[] | null> {
  return (await entityScopeFor(ctx.admin, ctx.access)).vehicleNames
}

async function letterOf(ctx: AgentToolContext, id: unknown) {
  const letter = unwrap(await getLetter(ctx.admin, ctx.fundId, await visible(ctx), String(id ?? '')))
  if (!letter) throw new Error('No letter with that id. Use lp_letters to list them.')
  return letter
}

const summary = (l: any) => ({
  id: l.id, period: l.period_label, vehicle: l.portfolio_group, status: l.status, year_end: !!l.is_year_end, updated_at: l.updated_at,
})

export const LETTER_HANDLERS: Record<string, AgentToolHandler> = {
  lp_letters: async (ctx: AgentToolContext, input: any) => {
    const vehicle = input?.vehicle ? await resolveVehicle(ctx.admin, ctx.fundId, String(input.vehicle), { access: ctx.access }) : null
    const letters = unwrap(await listLetters(ctx.admin, ctx.fundId, await visible(ctx)))
    return { letters: letters.filter(l => !vehicle || l.portfolio_group === vehicle).map(summary) }
  },

  lp_letter: async (ctx: AgentToolContext, input: any) => {
    const l = await letterOf(ctx, input?.letter_id)
    return {
      ...summary(l),
      prompt: l.generation_prompt ?? null,
      full_draft: l.full_draft ?? null,
      sections: ((l.company_narratives ?? []) as any[]).map(n => ({ company_id: n.company_id, company: n.company_name, narrative: n.narrative })),
      generation_error: l.generation_error ?? null,
    }
  },

  lp_letter_data: async (ctx: AgentToolContext, input: any) => {
    const l = await letterOf(ctx, input?.letter_id)
    return { letter: summary(l), ...(await letterData(ctx.admin, ctx.fundId, l)) }
  },

  lp_letter_pdf: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const l = await letterOf(ctx, input?.letter_id)
    if (l.status === 'generating') throw new Error('This letter is being generated. Ask again when it finishes.')
    const { token, expiresAt } = signReportLink({ fundId: ctx.fundId, userId, kind: 'lp_letter', args: { letter: l.id } })
    return { document: `${l.period_label} letter (PDF)`, url: reportLinkUrl(ctx.origin ?? siteOrigin(), token), expires_at: expiresAt }
  },

  lp_create_letter: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const vehicle = await resolveVehicle(ctx.admin, ctx.fundId, String(input?.vehicle ?? '') || undefined, { access: ctx.access })
    const year = Number(input?.year)
    const quarter = Number(input?.quarter)
    if (!Number.isInteger(year) || year < 1990 || year > 2100) throw new Error('year must be a four-digit year')
    if (![1, 2, 3, 4].includes(quarter)) throw new Error('quarter must be 1 to 4')
    const row = unwrap(await createLetter(ctx.admin, { fundId: ctx.fundId, userId, visible: await visible(ctx) }, {
      period_year: year, period_quarter: quarter, portfolio_group: vehicle, is_year_end: !!input?.year_end,
      generation_prompt: input?.prompt ? String(input.prompt) : null,
    }))
    return { letter: summary(row), next: 'Get the figures with lp_letter_data and write the company sections with lp_write_letter.' }
  },

  lp_write_letter: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const id = String(input?.letter_id ?? '')
    const v = await visible(ctx)
    const sections = Array.isArray(input?.sections) ? input.sections : null
    const fullDraft = typeof input?.full_draft === 'string' ? input.full_draft : undefined
    if (!sections && fullDraft === undefined && !input?.mark_complete) throw new Error('Pass sections, full_draft or mark_complete.')
    if (sections) {
      const clean = sections.map((s: any) => ({ company_id: String(s?.company_id ?? ''), narrative: String(s?.narrative ?? '') }))
      if (clean.some((s: any) => !s.company_id || !s.narrative.trim())) throw new Error('Each section needs a company_id and its text.')
      unwrap(await writeLetterSections(ctx.admin, { fundId: ctx.fundId, userId, visible: v }, id, clean))
    }
    let row: any = null
    if (fullDraft !== undefined || input?.mark_complete) {
      row = unwrap(await updateLetter(ctx.admin, { fundId: ctx.fundId, visible: v }, id, {
        ...(fullDraft !== undefined ? { full_draft: fullDraft } : {}),
        ...(input?.mark_complete ? { status: 'complete' } : {}),
      }))
    } else {
      row = await letterOf(ctx, id)
    }
    return { letter: summary(row), sections_written: sections?.length ?? 0 }
  },

  lp_share_letter: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const l = await letterOf(ctx, input?.letter_id)
    const refs: unknown[] = Array.isArray(input?.investors) ? input.investors : []
    const investors = await Promise.all(refs.map(r => resolveInvestor(ctx.admin, ctx.fundId, String(r ?? ''))))
    const out = unwrap(await shareLetter(ctx.admin, { fundId: ctx.fundId, userId }, l.id, investors.map(i => i.id)))
    return {
      letter: summary(l),
      shared_with: investors.filter(i => out.lp_investor_ids.includes(i.id)).map(i => i.name),
      note: out.lp_investor_ids.length ? 'They see it in their portal now.' : 'The letter is no longer shared with anyone.',
    }
  },
}
