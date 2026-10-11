// Write operations as an agent states them — accounts by CODE, a plan by id — normalised onto the
// service. Shared by the MCP write tools (which run directly) and the Analyst's staged actions
// (preview now, execute on approval), so the two cannot interpret the same request differently.

import { randomUUID } from 'node:crypto'
import { CapitalError, validateCapital, type CapitalSettings } from './capital'
import { AdjustmentError, cashCellAdjustments, NO_ADJUSTMENTS, validateAdjustments, type Adjustments, type CashCategory, dealEditRefusal } from './adjustments'
import { getPlan, savePlan, publishPlan, createPlan, suggestRules, ForecastError, type CreatePlanInput, type ForecastServiceContext, type PlanDetail, type SavePlanInput } from './service'
import { isMonthKey } from './months'

export interface UpdatePlanAction {
  vehicle: string
  planId: string
  /** Optional: the revision the request was made against. Omitted = the plan as it is when applied. */
  expectedRevision?: number
  rules?: { account: string; method: string; params: unknown; cashTiming?: unknown; note?: string | null }[]
  removeRules?: string[]
  overrides?: { account: string; month: string; amount: number | null; note?: string | null }[]
  /**
   * Hand edits (lib/forecast/adjustments.ts). `entries` adds an entry — or, with `replaces` (a
   * generated entry's key from forecast_explain) stands in for that one, or with `id` (a hand entry's
   * id, 'manual|<id>' key) changes it. `removeEntries` takes keys: a generated entry's, or a hand
   * entry's. `restoreEntries` puts back generated entries removed earlier.
   */
  entries?: { id?: string; date: string; memo: string; lines: { account: string; amount: number }[]; replaces?: string | null }[]
  removeEntries?: string[]
  restoreEntries?: string[]
  /**
   * A month's cash on a line, as a figure. Investments and exit proceeds write that month's entry
   * (cashCellAdjustments); capital calls and distributions are month edits to the plan's capital
   * management (lib/forecast/capital.ts), and the waterfall reruns on them.
   */
  cashFigures?: { line: CashCategory; month: string; amount: number | null }[]
  /** The plan's call and distribution policy (lib/forecast/capital.ts CapitalPolicy). */
  capitalPolicy?: { callReserve?: number; distributionLagMonths?: number; distributionReserve?: number }
  patch?: SavePlanInput['patch']
  explanation?: string
}

export const UPDATE_PLAN_SCHEMA = {
  type: 'object',
  required: ['vehicle', 'planId'],
  additionalProperties: false,
  properties: {
    vehicle: { type: 'string', description: 'Vehicle name.' },
    planId: { type: 'string', description: 'Plan id from forecast_list_plans.' },
    expectedRevision: { type: 'number', description: 'The plan revision you read; a stale one is refused.' },
    rules: {
      type: 'array',
      description: 'Set the rule on an account (replaces any existing rule on it).',
      items: {
        type: 'object',
        required: ['account', 'method', 'params'],
        additionalProperties: false,
        properties: {
          account: { type: 'string', description: 'Account code (e.g. "5210") or id.' },
          method: { type: 'string', enum: ['manual', 'fixed', 'recurring', 'run_rate', 'growth', 'seasonal', 'linked_fee', 'management_fee'] },
          params: {
            type: 'object',
            description:
              'manual {amounts:{"YYYY-MM":n}} · fixed {amount,start?,end?} · recurring {amount,everyMonths,anchor:"YYYY-MM",start?,end?,annualEscalation?,exceptions?,oneOffs?} · ' +
              'run_rate {window:3|6|12} or {from,to}, includeUnclosed? · growth {base,baseMonth,rate,per:"month"|"year"} · ' +
              'management_fee {rate, basis:"committed"|"invested"|"nav", termYears, stepDownYear?, stepDownRate?} — a fund\'s fee on its fee-paying commitments (GP stake exempt) · ' +
              'linked_fee {fundVehicle} — a management company\'s fee income from its funds. Amounts are positive for revenue and for expense.',
          },
          cashTiming: {
            type: 'object',
            description: '{mode:"same"} · {mode:"offset",months:-36..36} (negative = in advance) · {mode:"month",month:1-12,direction:"advance"|"arrears"} · ' +
              '{mode:"prepaid"} — already paid before the plan (a prepaid fee being expensed monthly): draws down the prepaid balance, no cash in the plan. ' +
              'Add refundMonth:"YYYY-MM" when what is still prepaid is refunded (a fee prepaid for the fund\'s life, refunded when it winds up early): the cost stops that month and the rest comes back as cash paid out to the investors.',
          },
          note: { type: 'string' },
        },
      },
    },
    removeRules: { type: 'array', items: { type: 'string' }, description: 'Account codes whose rule to remove.' },
    entries: {
      type: 'array',
      description:
        'Hand entries — for what rules and construction cannot say: an exit later or larger than construction has it, a ' +
        'distribution or call it does not know about, a one-off. Each is balanced (lines sum to zero; debit positive). ' +
        'To change a generated construction/opening entry, pass its key from forecast_explain as `replaces`; to change a ' +
        'hand entry, pass its id. A P&L month is better changed with `overrides`.',
      items: {
        type: 'object',
        required: ['date', 'memo', 'lines'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: "A hand entry's id, to change it (its key is 'manual|<id>')." },
          date: { type: 'string', description: 'YYYY-MM-DD, inside the plan window.' },
          memo: { type: 'string' },
          lines: {
            type: 'array',
            items: {
              type: 'object', required: ['account', 'amount'], additionalProperties: false,
              properties: { account: { type: 'string', description: 'Account code — any account in the chart, not only P&L.' }, amount: { type: 'number', description: 'Debit positive, credit negative.' } },
            },
          },
          replaces: { type: 'string', description: "The generated entry's key, from forecast_explain." },
        },
      },
    },
    removeEntries: { type: 'array', items: { type: 'string' }, description: "Keys from forecast_explain: a generated entry's (construction|… / opening|…) or a hand entry's (manual|<id>)." },
    restoreEntries: { type: 'array', items: { type: 'string' }, description: 'Keys of generated entries removed earlier, to put back.' },
    cashFigures: {
      type: 'array',
      description:
        'The simplest edit: a month\'s capital call or distribution, as an amount — it overrides the calls/distributions ' +
        'policy for that month and the waterfall reruns on it. Amount is positive; null goes back to the policy. ' +
        'Investments and exits are not set here: change the deal with update_portfolio_construction (the Investments tab).',
      items: {
        type: 'object', required: ['line', 'month', 'amount'], additionalProperties: false,
        properties: {
          line: { type: 'string', enum: ['called', 'distributed'] },
          month: { type: 'string', description: 'YYYY-MM' },
          amount: { type: ['number', 'null'], description: 'null clears a call/distribution month edit (back to the policy)' },
        },
      },
    },
    capitalPolicy: {
      type: 'object',
      additionalProperties: false,
      description: 'How calls and distributions are worked out when no month is set: keep callReserve of cash (calls fund any shortfall); pay exit proceeds distributionLagMonths after they arrive, keeping distributionReserve.',
      properties: { callReserve: { type: 'number' }, distributionLagMonths: { type: 'number' }, distributionReserve: { type: 'number' } },
    },
    overrides: {
      type: 'array',
      description: 'Set one month of one account (amount null clears the override).',
      items: {
        type: 'object',
        required: ['account', 'month', 'amount'],
        additionalProperties: false,
        properties: {
          account: { type: 'string' },
          month: { type: 'string', description: 'YYYY-MM' },
          amount: { type: ['number', 'null'] },
          note: { type: 'string' },
        },
      },
    },
    patch: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        scenario: { type: ['string', 'null'] },
        actualsCutoff: { type: ['string', 'null'], description: 'YYYY-MM; null = the last closed month.' },
        horizonMonths: { type: 'number' },
        endMonth: { type: 'string' },
        status: { type: 'string', enum: ['active', 'archived'] },
        isPrimary: { type: 'boolean', description: "true makes this the entity's primary plan — the one its headline figures, a management company's fee income and a GP entity's share are read from. Only on the user's say-so." },
        openingSettlementMonths: { type: 'number', description: 'When payables/receivables open at the start settle (1 = first month, 0 = never).' },
      },
    },
    explanation: { type: 'string', description: 'Why — shown to the approver.' },
  },
} as const

export const PUBLISH_PLAN_SCHEMA = {
  type: 'object',
  required: ['vehicle', 'planId', 'status'],
  additionalProperties: false,
  properties: {
    vehicle: { type: 'string' },
    planId: { type: 'string' },
    status: { type: 'string', enum: ['published', 'approved'], description: "'approved' = the budget baseline (one per plan)." },
    label: { type: 'string' },
    notes: { type: 'string' },
    expectedRevision: { type: 'number' },
  },
} as const

export const CREATE_PLAN_SCHEMA = {
  type: 'object',
  required: ['vehicle', 'kind', 'name'],
  additionalProperties: false,
  properties: {
    vehicle: { type: 'string' },
    kind: { type: 'string', enum: ['budget', 'rolling_forecast'] },
    name: { type: 'string' },
    fiscalYear: { type: 'number', description: 'Required for a budget.' },
    horizonMonths: { type: 'number', description: 'Rolling forecast: 12, 18, 24 or 36.' },
    endMonth: { type: 'string', description: 'Rolling forecast: a fixed end month instead of a horizon.' },
    actualsCutoff: { type: 'string', description: 'YYYY-MM; omit for the last closed month.' },
    includeConstruction: { type: 'boolean', description: 'Ignored — portfolio construction is always part of a plan.' },
    seed: {
      type: 'object',
      description:
        "'suggested' (default) = a rule per account from its own 12–36 months of closed history (forecast_suggest_rules); " +
        "'last_year' = last year's actuals month by month (budgets); 'plan' = copy another plan's rules; 'blank'.",
      properties: {
        from: { type: 'string', enum: ['blank', 'suggested', 'last_year', 'plan'] },
        planId: { type: 'string' },
        lookbackMonths: { type: 'number', description: '12–36; default 36 (as much as the books have).' },
      },
      required: ['from'],
      additionalProperties: false,
    },
    rules: {
      type: 'array',
      description: 'Rules to set after seeding — your adjustments to the suggestions (same shape as forecast_update_plan rules).',
      items: UPDATE_PLAN_SCHEMA.properties.rules.items,
    },
    explanation: { type: 'string', description: 'What you changed from the suggestions and why — shown to the approver.' },
  },
} as const

function accountId(detail: PlanDetail, ref: unknown): string {
  if (typeof ref !== 'string' || !ref.trim()) throw new ForecastError('account is required')
  const hit = detail.accounts.find(a => a.id === ref || a.code === ref.trim())
  if (!hit) throw new ForecastError(`No income or expense account "${ref}" in ${detail.plan.vehicle}'s chart`)
  return hit.id
}

export function toSaveInput(detail: PlanDetail, a: UpdatePlanAction): SavePlanInput {
  for (const o of a.overrides ?? []) if (!isMonthKey(o.month)) throw new ForecastError(`override month "${o.month}" must be YYYY-MM`)
  return {
    vehicle: detail.plan.vehicle,
    planId: detail.plan.id,
    expectedRevision: a.expectedRevision ?? detail.plan.revision,
    patch: a.patch,
    rules: (a.rules ?? []).map(r => ({ accountId: accountId(detail, r.account), method: r.method as any, params: r.params, cashTiming: r.cashTiming, note: r.note ?? null })),
    removeRules: (a.removeRules ?? []).map(r => accountId(detail, r)),
    overrides: (a.overrides ?? []).map(o => ({ accountId: accountId(detail, o.account), month: o.month, amount: o.amount, note: o.note ?? null })),
    ...(a.entries?.length || a.removeEntries?.length || a.restoreEntries?.length || dealFigures(a).length ? { adjustments: nextAdjustments(detail, a) } : {}),
    ...(capitalFigures(a).length || a.capitalPolicy ? { capital: nextCapital(detail, a) } : {}),
  }
}

/** The plan's hand edits after this update: entries added or changed, keys removed or restored. */
export function nextAdjustments(detail: PlanDetail, a: UpdatePlanAction): Adjustments {
  const cur = detail.plan.adjustments ?? NO_ADJUSTMENTS
  const anyAccount = (ref: string) => {
    const hit = detail.allAccounts.find(x => x.id === ref || x.code === String(ref).trim())
    if (!hit) throw new ForecastError(`No account "${ref}" in ${detail.plan.vehicle}'s chart`)
    return hit.id
  }
  const removeKeys = new Set(a.removeEntries ?? [])
  let entries = cur.entries.filter(e => !removeKeys.has(`manual|${e.id}`))
  for (const e of a.entries ?? []) {
    const id = e.id?.replace(/^manual\|/, '') || randomUUID()
    if (e.replaces && !detail.entries.some(x => x.key === e.replaces) && !cur.entries.some(x => x.replaces === e.replaces)) {
      throw new ForecastError(`No generated entry with key "${e.replaces}" — read the keys from forecast_explain`)
    }
    const next = { id, date: e.date, memo: e.memo, replaces: e.replaces ?? cur.entries.find(x => x.id === id)?.replaces ?? null,
      postings: (e.lines ?? []).map(l => ({ accountId: anyAccount(l.account), amount: Number(l.amount) })) }
    entries = [...entries.filter(x => x.id !== id), next]
  }
  const restore = new Set(a.restoreEntries ?? [])
  // Investments and exits are entered on the Investments tab (update_portfolio_construction), never as
  // a cash figure; calls and distributions are capital edits (nextCapital).
  if (dealFigures(a).length) {
    throw new ForecastError('Investments and exits are entered on the Investments tab — change the deal with update_portfolio_construction, not a cash figure')
  }
  const removed = [...new Set([...cur.removed.filter(k => !restore.has(k)), ...[...removeKeys].filter(k => !k.startsWith('manual|'))])]
  // Checked the way the service checks it, so a bad entry is refused when staged, not at approval.
  try {
    const next = validateAdjustments({ entries, removed }, detail.allAccounts)
    const refused = dealEditRefusal(cur, next, detail.allAccounts)
    if (refused) throw new ForecastError(refused)
    return next
  } catch (err) {
    if (err instanceof AdjustmentError) throw new ForecastError(err.message)
    throw err
  }
}

export async function applyUpdate(ctx: ForecastServiceContext, a: UpdatePlanAction): Promise<PlanDetail> {
  const detail = await getPlan(ctx, { vehicle: a.vehicle, planId: a.planId })
  return savePlan(ctx, toSaveInput(detail, a))
}

/** What an update would change, account by account — for the approver, before anything runs. */
export async function describeUpdate(ctx: ForecastServiceContext, a: UpdatePlanAction) {
  const detail = await getPlan(ctx, { vehicle: a.vehicle, planId: a.planId })
  const save = toSaveInput(detail, a) // validates account references now, not at approval
  const name = (id: string) => {
    const acct = detail.accounts.find(x => x.id === id)!
    return `${acct.code} ${acct.name}`
  }
  const rules = (save.rules ?? []).map(r => ({
    account: name(r.accountId),
    before: detail.rules.find(x => x.accountId === r.accountId) ?? null,
    after: { method: r.method, params: r.params, cashTiming: r.cashTiming ?? { mode: 'same' } },
  }))
  const removed = (save.removeRules ?? []).map(id => ({ account: name(id), before: detail.rules.find(x => x.accountId === id) ?? null }))
  const overrides = (save.overrides ?? []).map(o => ({
    account: name(o.accountId),
    month: o.month,
    before: detail.overrides.find(x => x.accountId === o.accountId && x.month === o.month)?.amount ?? null,
    after: o.amount,
  }))
  // Hand edits, in the words an approver reads them.
  const before = detail.plan.adjustments ?? NO_ADJUSTMENTS
  const after = (save.adjustments as Adjustments | undefined) ?? before
  const acct = (id: string) => { const x = detail.allAccounts.find(y => y.id === id); return x ? `${x.code} ${x.name}` : id }
  const handEntries = after.entries.filter(e => !before.entries.some(b => JSON.stringify(b) === JSON.stringify(e))).map(e => ({
    date: e.date, memo: e.memo, replaces: e.replaces ? (detail.entries.find(x => x.key === e.replaces)?.memo ?? e.replaces) : null,
    lines: e.postings.map(p => `${acct(p.accountId)} ${p.amount > 0 ? 'Dr' : 'Cr'} ${Math.abs(p.amount).toLocaleString('en-US')}`),
  }))
  const handRemoved = [
    ...after.removed.filter(k => !before.removed.includes(k)).map(k => detail.entries.find(x => x.key === k)?.memo ?? k),
    ...before.entries.filter(b => !after.entries.some(e => e.id === b.id)).map(b => b.memo),
  ]
  const handRestored = before.removed.filter(k => !after.removed.includes(k))
  // Capital management: month edits set or cleared, and the policy.
  const capBefore = detail.plan.capital ?? validateCapital({})
  const capAfter = (save.capital as CapitalSettings | undefined) ?? capBefore
  const capitalEdits = (['calls', 'distributions'] as const).flatMap(k => {
    const months = new Set([...Object.keys(capBefore[k]), ...Object.keys(capAfter[k])])
    return [...months].sort().filter(m => capBefore[k][m] !== capAfter[k][m]).map(m => ({
      line: k === 'calls' ? 'Capital call' : 'Distribution', month: m, before: capBefore[k][m] ?? null, after: capAfter[k][m] ?? 'back to the policy',
    }))
  })
  const policyChanged = JSON.stringify(capBefore.policy) !== JSON.stringify(capAfter.policy)
  const parts = [
    capitalEdits.length && `${capitalEdits.length} call/distribution month${capitalEdits.length === 1 ? '' : 's'}`,
    policyChanged && 'capital policy',
    handEntries.length && `${handEntries.length} hand entr${handEntries.length === 1 ? 'y' : 'ies'}`,
    handRemoved.length && `remove ${handRemoved.length} entr${handRemoved.length === 1 ? 'y' : 'ies'}`,
    handRestored.length && `restore ${handRestored.length} entr${handRestored.length === 1 ? 'y' : 'ies'}`,
    rules.length && `${rules.length} rule${rules.length === 1 ? '' : 's'}`,
    removed.length && `remove ${removed.length} rule${removed.length === 1 ? '' : 's'}`,
    overrides.length && `${overrides.length} month override${overrides.length === 1 ? '' : 's'}`,
    a.patch && Object.keys(a.patch).length && 'plan settings',
  ].filter(Boolean)
  return {
    summary: `Update ${detail.plan.name} (${detail.plan.vehicle}): ${parts.join(', ') || 'recompile against current actuals'}`,
    details: {
      vehicle: detail.plan.vehicle,
      plan: detail.plan.name,
      revision: detail.plan.revision,
      rules,
      removed,
      overrides,
      ...(capitalEdits.length ? { capital: capitalEdits } : {}),
      ...(policyChanged ? { capitalPolicy: { before: capBefore.policy, after: capAfter.policy } } : {}),
      ...(handEntries.length ? { entries: handEntries } : {}),
      ...(handRemoved.length ? { removedEntries: handRemoved } : {}),
      ...(handRestored.length ? { restoredEntries: handRestored.length } : {}),
      ...(a.patch ? { patch: a.patch } : {}),
      ...(a.explanation ? { explanation: a.explanation } : {}),
    },
  }
}

export interface PublishAction {
  vehicle: string
  planId: string
  status: 'published' | 'approved'
  label?: string | null
  notes?: string | null
  expectedRevision?: number
}

export async function applyPublish(ctx: ForecastServiceContext, a: PublishAction) {
  const detail = await getPlan(ctx, { vehicle: a.vehicle, planId: a.planId })
  return publishPlan(ctx, {
    vehicle: detail.plan.vehicle, planId: detail.plan.id, expectedRevision: a.expectedRevision ?? detail.plan.revision,
    status: a.status, label: a.label ?? null, notes: a.notes ?? null,
  })
}

export async function describePublish(ctx: ForecastServiceContext, a: PublishAction) {
  const detail = await getPlan(ctx, { vehicle: a.vehicle, planId: a.planId })
  if (a.status === 'approved' && detail.versions.some(v => v.status === 'approved')) {
    throw new ForecastError(`${detail.plan.name} already has an approved baseline; publish a revision instead`, 409)
  }
  return {
    summary: `${a.status === 'approved' ? 'Approve' : 'Publish'} ${detail.plan.name} (${detail.plan.vehicle}) as version ${(detail.versions[0]?.versionNo ?? 0) + 1}, actuals through ${detail.cutoff}`,
    details: { vehicle: detail.plan.vehicle, plan: detail.plan.name, status: a.status, label: a.label ?? null, cutoff: detail.cutoff, stale: detail.stale },
  }
}

export interface CreatePlanAction extends Omit<CreatePlanInput, 'seed'> {
  seed?: { from: 'blank' | 'suggested' | 'last_year' | 'plan'; planId?: string; lookbackMonths?: number }
  rules?: UpdatePlanAction['rules']
  explanation?: string
}

/** Create the plan, seeded, then apply any adjustments — one plan, one approval. */
export async function applyCreate(ctx: ForecastServiceContext, input: CreatePlanAction): Promise<PlanDetail> {
  const { rules, explanation: _explanation, ...create } = input
  const plan = await createPlan(ctx, { ...create, seed: create.seed ?? { from: 'suggested' } })
  if (!rules?.length) return plan
  return savePlan(ctx, toSaveInput(plan, { vehicle: plan.plan.vehicle, planId: plan.plan.id, rules }))
}

/** What the new plan would hold, account by account, with each suggestion's evidence. */
export async function describeCreate(ctx: ForecastServiceContext, input: CreatePlanAction) {
  const seed = input.seed ?? { from: 'suggested' as const }
  const s = seed.from === 'suggested' ? await suggestRules(ctx, { vehicle: input.vehicle, lookbackMonths: seed.lookbackMonths }) : null
  const byCode = new Map((s?.suggestions ?? []).map(x => [x.code, x]))
  const adjusted = new Map((input.rules ?? []).map(r => {
    const hit = s?.suggestions.find(x => x.code === r.account || x.accountId === r.account)
    return [hit?.code ?? r.account, r]
  }))
  const rules = [
    ...[...byCode.values()].map(x => ({
      account: `${x.code} ${x.name}`,
      method: adjusted.get(x.code)?.method ?? x.method,
      params: adjusted.get(x.code)?.params ?? x.params,
      source: adjusted.has(x.code) ? 'adjusted' : 'suggested',
      confidence: x.confidence,
      evidence: x.evidence,
      warnings: x.warnings,
    })),
    ...[...adjusted.entries()].filter(([code]) => !byCode.has(code)).map(([code, r]) => ({ account: code, method: r.method, params: r.params, source: 'added' })),
  ]
  // A plan given an end month runs to it; only one with neither runs the default 12 months.
  const end = (input as { endMonth?: string }).endMonth
  const kind = input.kind === 'budget' ? `${input.fiscalYear} budget`
    : input.horizonMonths ? `${input.horizonMonths}-month rolling forecast`
    : end ? `rolling forecast through ${end}`
    : '12-month rolling forecast'
  return {
    summary: `Create "${input.name}" — a ${kind} for ${s?.vehicle ?? input.vehicle} with ${rules.length} account rule${rules.length === 1 ? '' : 's'}${adjusted.size ? ` (${adjusted.size} adjusted)` : ''}. Draft only; nothing is published.`,
    details: {
      vehicle: s?.vehicle ?? input.vehicle,
      seed: seed.from,
      history: s?.history ?? null,
      rules,
      warnings: s?.warnings ?? [],
      ...(input.explanation ? { explanation: input.explanation } : {}),
    },
  }
}

const dealFigures = (a: UpdatePlanAction) => (a.cashFigures ?? []).filter(f => f.line === 'invested' || f.line === 'proceeds') as { line: CashCategory; month: string; amount: number }[]
const capitalFigures = (a: UpdatePlanAction) => (a.cashFigures ?? []).filter(f => f.line === 'called' || f.line === 'distributed')

/** The plan's capital settings after this update: month edits set or cleared, policy changed. */
export function nextCapital(detail: PlanDetail, a: UpdatePlanAction): CapitalSettings {
  const cur = detail.plan.capital ?? validateCapital({})
  const next = { policy: { calls: { ...cur.policy.calls }, distributions: { ...cur.policy.distributions } }, calls: { ...cur.calls }, distributions: { ...cur.distributions } }
  for (const f of capitalFigures(a)) {
    if (!isMonthKey(f.month)) throw new ForecastError(`cash figure month "${f.month}" must be YYYY-MM`)
    const into = f.line === 'called' ? next.calls : next.distributions
    if (f.amount == null) delete into[f.month]
    else into[f.month] = Math.abs(Number(f.amount))
  }
  const p = a.capitalPolicy
  if (p?.callReserve != null) next.policy.calls.reserve = Number(p.callReserve)
  if (p?.distributionLagMonths != null) next.policy.distributions.lagMonths = Number(p.distributionLagMonths)
  if (p?.distributionReserve != null) next.policy.distributions.reserve = Number(p.distributionReserve)
  try {
    return validateCapital(next)
  } catch (err) {
    if (err instanceof CapitalError) throw new ForecastError(err.message)
    throw err
  }
}
