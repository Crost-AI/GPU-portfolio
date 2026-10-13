// Handlers for the fund-setup agent tools (lib/agent/setup-tools-manifest.ts). Admin only, by the
// registry: both tools are gated on the `admin` domain before they run.

import type { AgentToolHandler } from '@/lib/accounting/agent-tools'
import { computeSetupProgress, loadSetupFacts, type StepKey } from '@/lib/onboarding/progress'
import { applySetupPlan, parseSetupPlan } from '@/lib/onboarding/setup-plan'
import { productsFromVisibility, parseOnboardingRecord } from '@/lib/onboarding/wizard'
import { ACCESS_PRESETS } from '@/lib/access/presets'
import { siteOrigin } from '@/lib/site-links'
import { aiStatus, hasAnyAIKey } from '@/lib/ai/capabilities'

/** How each checklist step is done from chat, where a tool does it. The rest link to the web page. */
export const STEP_TOOLS: Partial<Record<StepKey, string>> = {
  products: 'setup_fund',
  entity: 'setup_fund',
  senders: 'setup_fund',
  lps: 'add_partner',
  investments: 'record_investment',
  open_books: 'post_ledger_text',
  first_close: 'close_period',
  forecast: 'forecast_create_plan',
}

/** Steps that need a secret or a third-party account, which do not belong in a chat. */
const WEB_ONLY: Partial<Record<StepKey, string>> = {
  ai_key: 'To run with no server key, record that with setup_fund { aiMode: "assistant" }: you then do the AI work in chat (see ai.worksWithoutKey). A server key is a secret: add it in Settings, or pass it to the bootstrap script, never in a chat.',
  inbound_email: 'Inbound email needs a Postmark or Mailgun account and a webhook; set it up in Settings.',
}

export const SETUP_HANDLERS: Record<string, AgentToolHandler> = {
  setup_status: async ({ admin, fundId, access, origin }) => {
    const db = admin as any
    const base = (origin ?? siteOrigin()).replace(/\/$/, '')
    const [facts, { data: fund }, { data: settings }, { data: members }] = await Promise.all([
      loadSetupFacts(admin, fundId, access),
      db.from('funds').select('name').eq('id', fundId).maybeSingle(),
      db.from('fund_settings').select('*').eq('fund_id', fundId).maybeSingle(),
      db.from('fund_members').select('user_id, role, all_entities, access_expires_at').eq('fund_id', fundId),
    ])
    const progress = computeSetupProgress(facts)
    const memberRows = (members ?? []) as { role: string; access_expires_at?: string | null }[]
    return {
      fund: fund?.name ?? null,
      products: productsFromVisibility(settings?.feature_visibility ?? null),
      agentAccess: !!settings?.agent_api_enabled,
      ai: aiStatus(hasAnyAIKey(settings), settings?.ai_mode),
      finished: !!parseOnboardingRecord(settings?.onboarding)?.completed_at,
      team: {
        admins: memberRows.filter(m => m.role === 'admin').length,
        members: memberRows.filter(m => m.role === 'member').length,
        withEndDate: memberRows.filter(m => m.access_expires_at).length,
      },
      entities: facts.vehicles.map(v => ({ name: v.name, kind: v.kind })),
      checklist: {
        done: progress.done,
        total: progress.total,
        complete: progress.complete,
        steps: progress.sections.flatMap(s => s.steps.map(st => ({
          section: s.title,
          step: st.key,
          title: st.title,
          status: st.status,
          ...(st.detail ? { detail: st.detail } : {}),
          ...(st.blockedBy ? { needs: st.blockedBy } : {}),
          ...(STEP_TOOLS[st.key] ? { tool: STEP_TOOLS[st.key] } : {}),
          ...(WEB_ONLY[st.key] ? { note: WEB_ONLY[st.key] } : {}),
          url: `${base}${st.href}`,
        }))),
      },
      presets: ACCESS_PRESETS.map(p => ({ key: p.key, label: p.label, description: p.description })),
    }
  },

  setup_fund: async ({ admin, fundId, userId }, input) => {
    if (!userId) throw new Error('setup_fund needs a person behind the credential.')
    const plan = parseSetupPlan(input)
    if ('error' in plan) throw new Error(plan.error)
    return applySetupPlan(admin, { fundId, actorId: userId }, plan)
  },
}
