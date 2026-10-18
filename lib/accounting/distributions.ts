import { capitalOperationKey, validCapitalDate, validCapitalAmounts } from './capital-operation-key'
import { distributionDeductions } from './call-extras'
import { loadSettlementReviews } from './settlement-reviews'
import { ensureVehicleAccounts } from './provision-accounts'
// Declaring a distribution — the outbound mirror of issuing a capital call.
//
// Declaring reduces each partner's capital and parks the obligation on 2300 Distributions
// payable. The wire that follows settles the payable, which is what lets a bank transaction be
// matched back to the declaration that authorized it.
//
// THE REGISTER. This originally had no table — the journal entry was the record and the
// outstanding balance derived from it. That was wrong, and notices are what proved it: the 2300
// payable is CLEARED as wires go out, so once a distribution is paid the ledger no longer says
// what was declared. A notice states an amount a partner was told they would receive, and that
// figure has to survive its own payment. `distribution_lines.amount` is that frozen figure.
//
// THE SPLIT. A fund-wide distribution is split THROUGH THE WATERFALL when the vehicle has carry
// terms (lib/accounting/distribution-waterfall.ts): capital back to the LPs first, then the
// hurdle, then the GP's catch-up and carry. The GP's take posts as its own entry, tagged
// `carry_distribution`, so it files against the accrued carry on the roll-forward rather than
// reading as a return of the GP's capital. A vehicle with no carry terms splits by capital
// balance, as before.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from './ledger'
import { allocateAmount, apportionCents } from './allocation'
import { accountIdByCode, ensureCapitalAccounts, persistEntry } from './persist'
import { DISTRIBUTION_PAYABLE_CODE } from './chart'
import { buildDistributionDeclarationEntry, buildRealisedCarryEntry } from './entries'
import { loadPostedLedger, loadEntityNames } from './load'
import { loadCapitalPostings } from './capital-source'
import { computeCapitalAccounts, bucketForSourceType, type CapitalPosting } from './capital-account'
import { vehicleIdByName } from './vehicle-id'
import { loadCarryTerms, type DatedContribution, type VehicleCarryTerms } from './carry'
import { reconcileSettlements, registerStatus, type LineStatus, type RegisterStatus, type Settlement } from './settlement'
import { loadSettlements } from './capital-calls'
import {
  splitDistribution,
  suggestedCharacter,
  ZERO_TIERS,
  type CashSplitExtras,
  type DistributionSplit,
  type PartnerEconomics,
  type PriorDistribution,
  type SplitMethod,
  type WaterfallTiers,
} from './distribution-waterfall'
import {
  UNCHARACTERISED,
  characterForLine,
  characterFromRow,
  isDistributionKind,
  isUncharacterised,
  validateCharacter,
  type DistributionCharacter,
  type DistributionKind,
} from './distribution-character'

export interface DistributionLineInput { lpEntityId: string; amount: number }

export interface DeclareDistributionInput {
  requestKey?: string
  distributionDate: string
  description?: string | null
  scope?: 'fund_wide' | 'per_lp'
  /** The LP lines. */
  lines: DistributionLineInput[]
  /** The GP's carry, per recipient. Posts as `carry_distribution`. */
  carryLines?: DistributionLineInput[]
  /** How the lines were produced. Defaults to manual — the honest answer for typed lines. */
  splitMethod?: SplitMethod
  /** The tier breakdown the waterfall produced, when it did. Stored for the notice and the K-1. */
  tiers?: WaterfallTiers | null
  /** K-1 box 19 form. Defaults to cash, which is every distribution this app can yet produce. */
  kind?: DistributionKind
  /** Return of capital / realized gain / income. Omitted or all-zero leaves it uncharacterised. */
  character?: DistributionCharacter
  /** distributable_cash: the cash available before the reserve, as previewed. */
  available?: number
  /** distributable_cash: the working-capital reserve held back. Becomes the next default. */
  reserve?: number
  /** distributable_cash: the preview's tier extras, frozen on the register for the notice. */
  cash?: CashSplitExtras | null
}

/**
 * Split a total across partners by ENDING CAPITAL BALANCE.
 *
 * The no-carry-terms split, kept for callers that ask for it by name. `previewDistribution` is
 * what the declare flow uses: it runs the waterfall when the vehicle has terms and falls back to
 * this when it does not.
 */
export async function proRataDistribution(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  total: number,
): Promise<DistributionLineInput[]> {
  const { capitalPostings } = await loadPostedLedger(admin, fundId, group)
  const basis = Array.from(computeCapitalAccounts(capitalPostings).entries())
    .map(([lpEntityId, a]) => ({ lpEntityId, commitment: a.ending }))
    .filter(o => o.commitment > 0)
  if (basis.length === 0) return []
  return Array.from(allocateAmount(total, basis).entries()).map(([lpEntityId, amount]) => ({ lpEntityId, amount }))
}

export interface DistributionPreview extends DistributionSplit {
  /** Names for the UI, so it need not join. */
  names: Record<string, string>
  /** What the waterfall suggests for the K-1 character. Editable before declaring. */
  suggestedCharacter: DistributionCharacter
  /** The carry terms in force, so the UI can say what it applied. The three distributable-cash
   *  fields are present only for that kind. */
  terms: {
    kind: string; carryRate: number; prefRate: number; recipients: string[]
    prefBasis?: string; prefDayCount?: string; rocLpShare?: number
  }
  /** distributable_cash only: cash available, the reserve held back, and what that leaves. */
  available?: number
  reserve?: number
  distributable?: number
  /** distributable_cash only: the newest declared distribution's reserve, as the form's default. */
  lastReserve?: number | null
}

export interface WaterfallHistory {
  partners: PartnerEconomics[]
  /** Dated contributions, recipients excluded (as the close excludes them), each naming its investor. */
  contributions: DatedContribution[]
  /** Every prior distribution as a fund-wide total per date: LP distributions and carry paid both left. */
  priors: PriorDistribution[]
  carryPaidToDate: number
}

/**
 * The history a distribution split replays, from the capital postings: each partner's economics as
 * at `asOf`, the dated contributions, and the prior distribution totals. Shared by the preview and
 * the pref ledger, so both read the same history.
 */
export function loadWaterfallHistory(capitalPostings: CapitalPosting[], recipientIds: Set<string>, asOf: string): WaterfallHistory {
  const accounts = computeCapitalAccounts(capitalPostings, { end: asOf })
  const partners = Array.from(accounts.entries()).map(([lpEntityId, a]) => ({
    lpEntityId,
    contributed: roundCents(a.contributions),
    distributed: roundCents(-a.distributions),
    ending: roundCents(a.ending),
  }))

  // Dated LP contributions for the hurdle — recipients excluded, as the close excludes them.
  const contributions: DatedContribution[] = capitalPostings
    .filter(p => p.lpEntityId && !recipientIds.has(p.lpEntityId) && bucketForSourceType(p.sourceType) === 'contributions')
    .map(p => ({ date: p.entryDate ?? asOf, amount: roundCents(-p.amount), lpEntityId: p.lpEntityId as string }))
    .filter(c => c.amount > 0)

  // Every prior distribution, as a fund-wide total per date: LP distributions and carry paid
  // both left the fund, and the waterfall is defined over what left.
  const priorByDate = new Map<string, number>()
  let carryPaidToDate = 0
  for (const p of capitalPostings) {
    if (!p.lpEntityId || p.amount <= 0) continue
    const isDist = bucketForSourceType(p.sourceType) === 'distributions'
    const isCarry = p.sourceType === 'carry_distribution'
    if (!isDist && !isCarry) continue
    const date = p.entryDate ?? asOf
    if (date > asOf) continue
    priorByDate.set(date, roundCents((priorByDate.get(date) ?? 0) + p.amount))
    if (isCarry && recipientIds.has(p.lpEntityId)) carryPaidToDate = roundCents(carryPaidToDate + p.amount)
  }
  const priors: PriorDistribution[] = Array.from(priorByDate.entries()).map(([date, amount]) => ({ date, amount }))
  return { partners, contributions, priors, carryPaidToDate }
}

export interface CashPreviewOptions {
  /** distributable_cash: cash available to distribute, before the reserve. Required for that kind. */
  available?: number
  /** distributable_cash: working-capital reserve held back. Required for that kind; >= 0, < available. */
  reserve?: number
  /** distributable_cash: unspent contingency inside the distribution, returned before the tiers (R8). */
  contingencyReturn?: number
}

/** A distributable-cash vehicle's distribution amount, or why the inputs cannot make one. */
function cashDistributable(opts: CashPreviewOptions): { total: number } | { error: string } {
  const available = Number(opts.available)
  const reserve = Number(opts.reserve)
  if (opts.available == null || !Number.isFinite(available) || available <= 0) {
    return { error: 'A positive available cash amount is required for a distributable-cash waterfall' }
  }
  if (opts.reserve == null || !Number.isFinite(reserve) || reserve < 0 || reserve >= available) {
    return { error: 'A reserve of at least 0 and less than the available cash is required' }
  }
  const total = roundCents(available - reserve)
  const contingency = Number(opts.contingencyReturn ?? 0)
  if (!Number.isFinite(contingency) || contingency < 0 || contingency > total) {
    return { error: 'The contingency returned must be at least 0 and at most the amount distributed' }
  }
  return { total }
}

/** The newest declared distribution's reserve, or null — the declaration form's default. */
async function lastReserve(admin: SupabaseClient, fundId: string, group: string): Promise<number | null> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return null
  const { data, error } = await (admin as any)
    .from('distributions')
    .select('reserve_amount')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'declared')
    .order('distribution_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`distributions read failed: ${error.message}`)
  return data?.reserve_amount == null ? null : Number(data.reserve_amount)
}

/**
 * How a fund-wide distribution of `total` would be split on `asOf`, writing nothing.
 *
 * `method` 'pro_rata' forces the capital-balance split even when carry terms exist — the escape
 * hatch for a distribution the LPA treats specially. Default: the waterfall when terms exist.
 *
 * A distributable_cash vehicle (a GPU SPV) does not take `total`: it takes the cash `available`
 * and a required `reserve`, and distributes the difference (Karl, Q5).
 */
export async function previewDistribution(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  total: number,
  asOf: string,
  method: 'waterfall' | 'pro_rata' = 'waterfall',
  opts: CashPreviewOptions = {},
): Promise<DistributionPreview | { error: string }> {
  // From whichever producer the vehicle uses: the ledger, or a tracking vehicle's positions.
  const [{ postings: capitalPostings }, terms, names] = await Promise.all([
    loadCapitalPostings(admin, fundId, group),
    loadCarryTerms(admin, fundId, group),
    loadEntityNames(admin, fundId, group),
  ])
  const isCash = terms.kind === 'distributable_cash'
  if (isCash) {
    const amount = cashDistributable(opts)
    if ('error' in amount) return amount
    total = amount.total
  } else if (!Number.isFinite(total) || total <= 0) {
    return { error: 'A positive total is required' }
  }
  const effectiveTerms = method === 'pro_rata' ? { ...terms, kind: 'none' as const } : terms
  const recipientIds = new Set(terms.recipients.map(r => r.lpEntityId))
  const { partners, contributions, priors, carryPaidToDate } = loadWaterfallHistory(capitalPostings, recipientIds, asOf)

  const split = splitDistribution({
    total,
    terms: effectiveTerms,
    partners,
    contributions,
    priors,
    asOf,
    carryPaidToDate: recipientIds.size > 0 ? carryPaidToDate : undefined,
    ...(isCash ? { contingencyReturn: Number(opts.contingencyReturn ?? 0) } : {}),
  })

  const nameOf = (id: string) => names.get(id) ?? id
  const preview: DistributionPreview = {
    ...split,
    // Warnings name entity ids; say the partner's name instead.
    warnings: split.warnings.map(w => Array.from(names.entries()).reduce((s, [id, n]) => s.split(id).join(n), w)),
    names: Object.fromEntries([...split.lines, ...split.carryLines].map(l => [l.lpEntityId, nameOf(l.lpEntityId)])),
    suggestedCharacter: suggestedCharacter(split.tiers, roundCents(total)),
    terms: {
      kind: effectiveTerms.kind,
      carryRate: effectiveTerms.carryRate,
      prefRate: effectiveTerms.prefRate,
      recipients: effectiveTerms.recipients.map(r => nameOf(r.lpEntityId)),
    },
  }
  if (!isCash) return preview
  return {
    ...preview,
    available: roundCents(Number(opts.available)),
    reserve: roundCents(Number(opts.reserve)),
    distributable: total,
    lastReserve: await lastReserve(admin, fundId, group),
    terms: { ...preview.terms, prefBasis: terms.prefBasis, prefDayCount: terms.prefDayCount, rocLpShare: terms.rocLpShare },
  }
}

/**
 * The profit share REALISED by a distributable-cash declaration: Dr each investor's capital,
 * Cr each recipient's, so the carry_distribution that pays the recipient nets its account to zero
 * and each investor's statement shows the profit share it bore. A GPU SPV accrues no carry at the
 * close (Karl, R4: statements show PAID profit share only), so this is the only place it is booked.
 *
 * The investors bear it on the same basis as the profit split: contributed capital, cents placed
 * with apportionCents over investors sorted by id. It ties to the carry lines to the cent.
 */
async function realisedCarryPlan(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  terms: VehicleCarryTerms,
  perRecipient: Map<string, number>,
  asOf: string,
): Promise<{ perLp: Map<string, number> } | { error: string }> {
  const recipientIds = new Set(terms.recipients.map(r => r.lpEntityId))
  const { postings } = await loadCapitalPostings(admin, fundId, group)
  const contributed = new Map<string, number>()
  for (const c of loadWaterfallHistory(postings, recipientIds, asOf).contributions) {
    if (c.date > asOf) continue
    contributed.set(c.lpEntityId as string, roundCents((contributed.get(c.lpEntityId as string) ?? 0) + c.amount))
  }
  const ids = Array.from(contributed.keys()).sort((a, b) => a.localeCompare(b))
  if (ids.length === 0) return { error: 'No investor has contributed, so the profit share cannot be borne by anyone' }
  const total = Math.round(roundCents(Array.from(perRecipient.values()).reduce((s, v) => s + v, 0)) * 100)
  const parts = apportionCents(total, ids.map(id => Math.round(contributed.get(id)! * 100)))
  return { perLp: new Map(ids.map((id, i) => [id, parts[i] / 100] as [string, number]).filter(([, v]) => v > 0)) }
}

function cleanLines(lines: DistributionLineInput[] | undefined): Map<string, number> {
  const perLp = new Map<string, number>()
  for (const l of lines ?? []) {
    if (!l.lpEntityId || !(Number(l.amount) > 0)) continue
    perLp.set(l.lpEntityId, roundCents((perLp.get(l.lpEntityId) ?? 0) + Number(l.amount)))
  }
  return perLp
}

/**
 * Declare a distribution: Dr each partner's capital, Cr Distributions payable.
 *
 * Two entries when there is carry: the LP lines post as `distribution`, the carry lines as
 * `carry_distribution` — one source type per entry, so each files into the right roll-forward
 * bucket. The register row keeps both ids.
 */
export async function declareDistribution(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  input: DeclareDistributionInput,
): Promise<{ entryId: string; carryEntryId: string | null; carryRealizedEntryId: string | null; distributionId: string } | { error: string }> {

  if (!validCapitalAmounts([...(input.lines ?? []), ...(input.carryLines ?? [])])) return { error: 'Distribution amounts must be finite nonnegative amounts in cents' }
  const perLp = cleanLines(input.lines)
  const perRecipient = cleanLines(input.carryLines)
  if (perLp.size === 0 && perRecipient.size === 0) return { error: 'A distribution needs at least one partner with a positive amount' }
  if (!validCapitalDate(input.distributionDate)) return { error: 'A valid distribution date is required' }
  for (const id of Array.from(perRecipient.keys())) {
    if (perLp.has(id)) return { error: 'A partner cannot appear as both an LP line and a carry line' }
  }

  // Validate the character BEFORE anything is posted: a split that disagrees with what the
  // partners are being told they will receive is two claims about one wire, and the cheap moment
  // to refuse is before the journal entry exists.
  const character = input.character ?? UNCHARACTERISED
  const lpTotal = roundCents(Array.from(perLp.values()).reduce((s, v) => s + v, 0))
  const carryTotal = roundCents(Array.from(perRecipient.values()).reduce((s, v) => s + v, 0))
  const declaredTotal = roundCents(lpTotal + carryTotal)
  const characterProblem = validateCharacter(character, declaredTotal)
  if (characterProblem) return { error: characterProblem.error }

  const kind: DistributionKind = isDistributionKind(input.kind) ? input.kind : 'cash'
  const splitMethod: SplitMethod = input.splitMethod === 'waterfall' || input.splitMethod === 'pro_rata' ? input.splitMethod : 'manual'
  const tiers = splitMethod === 'waterfall' && input.tiers ? input.tiers : null
  const cash = splitMethod === 'waterfall' && input.cash ? input.cash : null
  if (input.reserve != null && !(Number.isFinite(Number(input.reserve)) && Number(input.reserve) >= 0)) {
    return { error: 'The reserve must be a finite amount of at least 0' }
  }

  const vehicleId = await vehicleIdByName(admin, fundId, group)
  // Refuse before anything is written, for the reason spelled out in issueCapitalCall: a null
  // vehicle id defeats the request-key uniqueness and the retry lookup, and the publication would
  // fail afterwards regardless, leaving drafts behind.
  if (!vehicleId) return { error: `"${group}" is not in this fund's vehicle registry, so a distribution cannot be recorded against it` }
  const requestKey = capitalOperationKey(input)
  const { data: prior, error: priorError } = await admin.from('distributions' as any)
    .select('id, status, journal_entry_id, carry_journal_entry_id, carry_realized_journal_entry_id, distribution_lines(id)').eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('request_key', requestKey).maybeSingle()
  if (priorError) return { error: priorError.message }
  const previous = prior as any
  if (previous?.status === 'declared') return { distributionId: previous.id, entryId: previous.journal_entry_id, carryEntryId: previous.carry_journal_entry_id, carryRealizedEntryId: previous.carry_realized_journal_entry_id ?? null }
  let entryId: string | null = previous?.journal_entry_id ?? null
  let carryEntryId: string | null = previous?.carry_journal_entry_id ?? null
  let carryRealizedEntryId: string | null = previous?.carry_realized_journal_entry_id ?? null
  let distributionId: string = previous?.id
  if (!previous) {
    // A distributable-cash vehicle accrues no carry at the close (Karl, R4), so paying a profit
    // share must realise it here, or the recipient's capital goes negative by what it was paid
    // and the investors' stays overstated. Worked out before anything is written.
    let realised: Map<string, number> | null = null
    if (perRecipient.size > 0) {
      let terms: VehicleCarryTerms
      try {
        terms = await loadCarryTerms(admin, fundId, group)
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
      if (terms.kind === 'distributable_cash') {
        const plan = await realisedCarryPlan(admin, fundId, group, terms, perRecipient, input.distributionDate)
        if ('error' in plan) return plan
        realised = plan.perLp
      }
    }

    await ensureVehicleAccounts(admin, fundId, group)
    const codes = await accountIdByCode(admin, fundId, group)
    const payableId = codes.get(DISTRIBUTION_PAYABLE_CODE)
    if (!payableId) {
      return { error: `The chart is missing account ${DISTRIBUTION_PAYABLE_CODE} Distributions payable — add it under the entity's Admin → Chart of accounts.` }
    }

    const capMap = await ensureCapitalAccounts(admin, fundId, group, Array.from(new Set([...Array.from(perLp.keys()), ...Array.from(perRecipient.keys()), ...Array.from(realised?.keys() ?? [])])))
    const base = { fundId, entryDate: input.distributionDate }

    // Posted, like a call issuance: declaring is the event. The SETTLEMENT is what arrives as a
    // draft later, from the bank.
    if (perLp.size > 0) {
      const entry = buildDistributionDeclarationEntry({ ...base, memo: input.description || 'Distribution' }, perLp, capMap, payableId)
      const result = await persistEntry(admin, fundId, group, userId, entry, 'draft')
      if ('error' in result) return { error: result.error }
      entryId = result.entryId
    }

    if (perRecipient.size > 0) {
      const entry = buildDistributionDeclarationEntry(
        { ...base, memo: `${input.description || 'Distribution'} — carried interest` },
        perRecipient, capMap, payableId,
      )
      entry.sourceType = 'carry_distribution'
      const result = await persistEntry(admin, fundId, group, userId, entry, 'draft')
      if ('error' in result) {
        const { error: cleanupError } = await admin.rpc('discard_unregistered_capital_drafts' as any, { p_fund_id: fundId, p_vehicle_id: vehicleId, p_entry_ids: [entryId].filter(Boolean) })
        return { error: `${result.error}${cleanupError ? `; draft cleanup failed: ${cleanupError.message}` : ''}` }
      }
      carryEntryId = result.entryId
    }

    if (realised && realised.size > 0) {
      const entry = buildRealisedCarryEntry(
        { ...base, memo: `${input.description || 'Distribution'} — profit share realised` },
        realised, perRecipient, capMap,
      )
      const result = await persistEntry(admin, fundId, group, userId, entry, 'draft')
      if ('error' in result) {
        const { error: cleanupError } = await admin.rpc('discard_unregistered_capital_drafts' as any, { p_fund_id: fundId, p_vehicle_id: vehicleId, p_entry_ids: [entryId, carryEntryId].filter(Boolean) })
        return { error: `${result.error}${cleanupError ? `; draft cleanup failed: ${cleanupError.message}` : ''}` }
      }
      carryRealizedEntryId = result.entryId
    }

    // The register, written in the same shape as issueCapitalCall's.
    const { data: row, error: regErr } = await (admin as any)
      .from('distributions')
      .insert({
        fund_id: fundId,
        vehicle_id: vehicleId,
        request_key: requestKey,
        distribution_date: input.distributionDate,
        description: input.description ?? null,
        scope: input.scope === 'per_lp' ? 'per_lp' : 'fund_wide',
        status: 'draft',
        journal_entry_id: entryId ?? carryEntryId,
        carry_journal_entry_id: carryEntryId,
        split_method: splitMethod,
        wf_return_of_capital: tiers?.returnOfCapital ?? null,
        wf_preferred: tiers?.preferred ?? null,
        wf_catch_up: tiers?.catchUp ?? null,
        wf_carry: tiers?.carry ?? null,
        // distributable_cash only; absent keys leave every other vehicle's row as it was written.
        ...(carryRealizedEntryId ? { carry_realized_journal_entry_id: carryRealizedEntryId } : {}),
        ...(cash ? {
          wf_contingency_return: cash.contingencyReturn,
          wf_profit_lp: cash.profitToLP,
          wf_pref_carried_forward: cash.prefCarriedForward,
          wf_unreturned_after: cash.unreturnedAfter,
        } : {}),
        ...(input.reserve != null ? { reserve_amount: roundCents(Number(input.reserve)) } : {}),
        kind,
        char_return_of_capital: character.returnOfCapital,
        char_realized_gain: character.realizedGain,
        char_income: character.income,
        created_by: userId,
      })
      .select('id')
      .single()
    if (regErr) {
      const { error: cleanupError } = await admin.rpc('discard_unregistered_capital_drafts' as any, { p_fund_id: fundId, p_vehicle_id: vehicleId, p_entry_ids: Array.from(new Set([entryId, carryEntryId, carryRealizedEntryId].filter(Boolean))) })
      return { error: `${regErr.message}${cleanupError ? `; draft cleanup failed: ${cleanupError.message}` : ''}` }
    }
    distributionId = (row as any).id
  }

  const lineRows = [
    ...Array.from(perLp.entries()).map(([lpEntityId, amount]) => ({ lpEntityId, amount, role: 'lp' })),
    ...Array.from(perRecipient.entries()).map(([lpEntityId, amount]) => ({ lpEntityId, amount, role: 'carry' })),
  ]
  const { error: finalizeError } = await admin.rpc('complete_capital_operation' as any, {
    p_fund_id: fundId, p_vehicle_id: vehicleId, p_kind: 'distribution', p_register_id: distributionId,
    p_entry_ids: Array.from(new Set([entryId, carryEntryId, carryRealizedEntryId].filter(Boolean))), p_lines: lineRows,
  })
  if (finalizeError) return { error: `Distribution remains a draft: ${finalizeError.message}` }
  return { entryId: entryId ?? carryEntryId ?? '', carryEntryId, carryRealizedEntryId, distributionId }
}

export interface DeclaredDistributionLine {
  /** The register line's id — what a notice hangs off. */
  id: string
  lpEntityId: string
  name: string
  amount: number
  /** 'lp' — a share of the LP tiers; 'carry' — the GP's take. */
  role: 'lp' | 'carry'
  character: DistributionCharacter
  /** What has been paid against THIS line, oldest declaration first (lib/accounting/settlement.ts). */
  settled: number
  outstanding: number
  status: LineStatus
  settledOn: string | null
  manualSettled?: number
  settlementReview?: string
  noticeDocumentId: string | null
}

export interface DeclaredDistribution extends RegisterStatus {
  distributionId: string
  entryId: string | null
  carryEntryId: string | null
  date: string
  description: string | null
  /** Everything declared — LP lines and carry lines. */
  total: number
  lpTotal: number
  carryTotal: number
  splitMethod: SplitMethod
  /** The waterfall tiers, when the split was one. Null for pro-rata and hand-typed lines.
   *  `cash` is present when it was a distributable-cash waterfall (frozen at declaration). */
  tiers: (WaterfallTiers & { cash?: CashSplitExtras }) | null
  /** distributable_cash: the reserve held back when it was declared; null otherwise. */
  reserve: number | null
  /** K-1 box 19 form. */
  kind: DistributionKind
  /** The three buckets as declared. All zero = never characterised, which is not the same as nil. */
  character: DistributionCharacter
  /** False when the distribution predates the character columns, or was declared without a split. */
  characterised: boolean
  /**
   * What each partner was DECLARED, frozen at declaration, with their share of each character
   * bucket derived from it — never stored, so the two cannot disagree.
   */
  lines: DeclaredDistributionLine[]
}

/**
 * Declared distributions, newest first, from the REGISTER.
 *
 * Read from `distribution_lines`, not from the 2300 payable: the payable tells you what is
 * still owed, which is zero once everyone has been paid. The register tells you what was
 * declared, which is what a notice restates and what an LP will hold you to.
 */
export async function listDistributions(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<DeclaredDistribution[]> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const [{ data: rows }, names, settlements, reviews] = await Promise.all([
    (admin as any)
      .from('distributions')
      .select('id, distribution_date, description, status, journal_entry_id, carry_journal_entry_id, split_method, wf_return_of_capital, wf_preferred, wf_catch_up, wf_carry, wf_contingency_return, wf_profit_lp, wf_pref_carried_forward, wf_unreturned_after, reserve_amount, kind, char_return_of_capital, char_realized_gain, char_income, distribution_lines(id, lp_entity_id, amount, role, notice_document_id, settled_amount, settled_on)')
      .eq('fund_id', fundId)
      .eq('vehicle_id', vehicleId)
      .order('distribution_date', { ascending: false })
      .limit(200),
    loadEntityNames(admin, fundId, group),
    loadSettlements(admin, fundId, group, 'payable'),
    loadSettlementReviews(admin, fundId, vehicleId, 'distribution'),
  ])
  const all = ((rows as any[]) ?? []).filter(row => row.status !== 'draft')
  // Fees, tax withheld, a call netted off — taken from what each partner is owed. They settle the
  // line like a wire (they debit the payable), so they are listed here only to say why.
  const deductions = await distributionDeductions(admin, fundId, vehicleId, all.map(d => d.id as string))

  // One FIFO pass over every line — see listCapitalCalls.
  const registerLines = all.flatMap(d => ((d.distribution_lines as any[]) ?? []).map(l => ({
    id: l.id as string, lpEntityId: l.lp_entity_id as string, date: d.distribution_date as string, amount: Number(l.amount),
  })))
  const manual: (Settlement & { lineId: string })[] = all.flatMap(d => ((d.distribution_lines as any[]) ?? [])
    .filter(l => Number(l.settled_amount) > 0)
    .map(l => ({ lineId: l.id as string, lpEntityId: l.lp_entity_id as string, date: (l.settled_on ?? d.distribution_date) as string, amount: Number(l.settled_amount) })))
  const settledByLine = reconcileSettlements(registerLines, settlements, manual, reviews)

  return all.map(d => {
    const character = characterFromRow(d)
    const rawLines = (d.distribution_lines ?? []).map((l: any) => {
      const s = settledByLine.get(l.id)
      return {
        id: l.id as string,
        lpEntityId: l.lp_entity_id as string,
        name: names.get(l.lp_entity_id) ?? l.lp_entity_id,
        amount: roundCents(Number(l.amount)),
        role: (l.role === 'carry' ? 'carry' : 'lp') as 'lp' | 'carry',
        settled: s?.settled ?? 0,
        outstanding: s?.outstanding ?? roundCents(Number(l.amount)),
        status: (s?.status ?? 'open') as LineStatus,
        settledOn: s?.settledOn ?? null,
        settlementReview: s?.settlementReview,
        manualSettled: Number(l.settled_amount ?? 0),
        noticeDocumentId: (l.notice_document_id ?? null) as string | null,
        deductions: deductions.get(d.id)?.get(l.lp_entity_id) ?? [],
      }
    })
    const total = roundCents(rawLines.reduce((s: number, l: any) => s + l.amount, 0))
    const carryTotal = roundCents(rawLines.filter((l: any) => l.role === 'carry').reduce((s: number, l: any) => s + l.amount, 0))
    const splitMethod: SplitMethod = d.split_method === 'waterfall' || d.split_method === 'pro_rata' ? d.split_method : 'manual'
    const tiers: DeclaredDistribution['tiers'] = splitMethod === 'waterfall' && d.wf_return_of_capital != null
      ? {
          ...ZERO_TIERS,
          returnOfCapital: Number(d.wf_return_of_capital ?? 0),
          preferred: Number(d.wf_preferred ?? 0),
          catchUp: Number(d.wf_catch_up ?? 0),
          carry: Number(d.wf_carry ?? 0),
          profitToLP: roundCents(total - carryTotal - Number(d.wf_return_of_capital ?? 0) - Number(d.wf_preferred ?? 0)),
          toLP: roundCents(total - carryTotal),
          toGP: carryTotal,
          ...(d.wf_unreturned_after != null ? cashTiersOf(d, carryTotal) : {}),
        }
      : null
    return {
      distributionId: d.id,
      entryId: d.journal_entry_id,
      carryEntryId: d.carry_journal_entry_id ?? null,
      date: d.distribution_date,
      description: d.description ?? null,
      total,
      lpTotal: roundCents(total - carryTotal),
      carryTotal,
      splitMethod,
      tiers,
      reserve: d.reserve_amount == null ? null : Number(d.reserve_amount),
      kind: isDistributionKind(d.kind) ? d.kind : 'cash',
      character,
      characterised: !isUncharacterised(character),
      lines: rawLines.map((l: any) => ({ ...l, character: characterForLine(character, l.amount, total) })),
      ...registerStatus(rawLines, null, today),
    }
  })
}

/** A distributable-cash row's frozen tiers: the profit split as declared, and the extras. */
function cashTiersOf(d: any, carryTotal: number): Partial<WaterfallTiers> & { cash: CashSplitExtras } {
  const contingencyReturn = Number(d.wf_contingency_return ?? 0)
  const profitToLP = Number(d.wf_profit_lp ?? 0)
  const prefCarriedForward = Number(d.wf_pref_carried_forward ?? 0)
  return {
    profitToLP,
    contingencyReturn,
    cash: {
      prefDue: roundCents(Number(d.wf_preferred ?? 0) + prefCarriedForward),
      prefCarriedForward,
      unreturnedAfter: Number(d.wf_unreturned_after),
      profitToLP,
      managerRocShare: roundCents(carryTotal - Number(d.wf_carry ?? 0)),
      contingencyReturn,
    },
  }
}
