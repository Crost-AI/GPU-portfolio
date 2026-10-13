/**
 * Applicability rules engine.
 * Maps intake questionnaire answers to compliance item applicability.
 */

export type Applicability = 'applies' | 'not_applicable' | 'needs_review' | 'monitor' | 'completed'

export interface ComplianceProfile {
  registration_status: string | null
  aum_range: string | null
  fund_structure: string | null
  fundraising_status: string | null
  reg_d_exemption: string | null
  investor_state_count: string | null
  california_nexus: string[] | null
  public_equity: string | null
  cftc_activity: string | null
  access_person_count: string | null
  has_foreign_entities: string | null
  has_foreign_investors: string | null
}

type Rule = (p: ComplianceProfile) => { result: Applicability; reason: string }

const rules: Record<string, Rule> = {
  'form-adv': (p) => {
    if (p.registration_status === 'ria' || p.registration_status === 'era')
      return { result: 'applies', reason: `Firm is registered as ${p.registration_status === 'ria' ? 'an RIA' : 'an ERA'}` }
    if (p.registration_status === 'not_registered')
      return { result: 'not_applicable', reason: 'Auto-dismissed: Firm is not registered with the SEC' }
    return { result: 'needs_review', reason: 'Registration status is unclear' }
  },

  'form-pf': (p) => {
    if (p.registration_status === 'era')
      return { result: 'not_applicable', reason: 'Auto-dismissed: ERAs are exempt from Form PF' }
    if (p.registration_status === 'not_registered')
      return { result: 'not_applicable', reason: 'Auto-dismissed: Firm is not registered with the SEC' }
    const bigAum = ['150m_500m', '500m_1.5b', 'over_1.5b']
    const smallAum = ['under_25m', '25m_100m', '100m_150m']
    if (p.registration_status === 'ria' && p.aum_range && bigAum.includes(p.aum_range))
      return { result: 'applies', reason: 'RIA with $150M+ in private fund AUM' }
    if (p.aum_range && smallAum.includes(p.aum_range))
      return { result: 'not_applicable', reason: 'Auto-dismissed: AUM below $150M threshold' }
    return { result: 'needs_review', reason: 'Registration status or AUM range is unclear' }
  },

  'form-13f': (p) => {
    if (p.public_equity === 'yes_over_100m')
      return { result: 'applies', reason: 'Holds $100M+ in public equities' }
    if (p.public_equity === 'no')
      return { result: 'not_applicable', reason: 'Auto-dismissed: Fund holds no public equities' }
    if (p.public_equity === 'yes_under_100m')
      return { result: 'not_applicable', reason: 'Auto-dismissed: Public equity holdings under $100M' }
    return { result: 'needs_review', reason: 'Public equity holdings status is unclear' }
  },

  'sched-13g': (p) => {
    if (p.public_equity === 'yes_5pct_single')
      return { result: 'applies', reason: 'Holds 5%+ of a single public company' }
    if (p.public_equity === 'no')
      return { result: 'not_applicable', reason: 'Auto-dismissed: Fund holds no public equities' }
    return { result: 'needs_review', reason: 'Public equity holdings status is unclear' }
  },

  'form-13h': (p) => {
    if (p.public_equity === 'no')
      return { result: 'not_applicable', reason: 'Auto-dismissed: Fund holds no public equities' }
    return { result: 'needs_review', reason: 'Rarely triggered for VC funds — review large trader thresholds' }
  },

  'form-npx': (p) => {
    if (p.public_equity === 'yes_over_100m')
      return { result: 'applies', reason: 'Required because firm files Form 13F' }
    if (p.public_equity === 'no' || p.public_equity === 'yes_under_100m')
      return { result: 'not_applicable', reason: 'Auto-dismissed: Form 13F not required' }
    return { result: 'needs_review', reason: 'Depends on Form 13F filing obligation' }
  },

  'form-d': (p) => {
    if (p.reg_d_exemption === '506b' || p.reg_d_exemption === '506c')
      return { result: 'applies', reason: `Fund raised capital under Reg D (Rule ${p.reg_d_exemption === '506b' ? '506(b)' : '506(c)'})` }
    if (p.reg_d_exemption === 'no')
      return { result: 'not_applicable', reason: 'Auto-dismissed: Fund did not raise capital under Reg D' }
    return { result: 'needs_review', reason: 'Reg D exemption status is unclear' }
  },

  'form-d-amendment-review': (p) => {
    if (p.reg_d_exemption === '506b' || p.reg_d_exemption === '506c')
      return { result: 'applies', reason: `Fund filed Form D under Reg D (Rule ${p.reg_d_exemption === '506b' ? '506(b)' : '506(c)'}) — annual amendment review required` }
    if (p.reg_d_exemption === 'no')
      return { result: 'not_applicable', reason: 'Auto-dismissed: Fund did not raise capital under Reg D' }
    return { result: 'needs_review', reason: 'Reg D exemption status is unclear' }
  },

  'blue-sky': (p) => {
    if (p.reg_d_exemption === 'no')
      return { result: 'not_applicable', reason: 'Auto-dismissed: Fund did not raise capital under Reg D' }
    if ((p.reg_d_exemption === '506b' || p.reg_d_exemption === '506c') && p.investor_state_count !== 'single_state')
      return { result: 'applies', reason: 'Fund raised under Reg D with investors in multiple states' }
    if (p.investor_state_count === 'single_state')
      return { result: 'not_applicable', reason: 'Auto-dismissed: Investors in only one state' }
    return { result: 'needs_review', reason: 'Reg D or investor geography status is unclear' }
  },

  'cftc-exemption': (p) => {
    if (p.cftc_activity === 'yes_with_exemption')
      return { result: 'applies', reason: 'CPO exemption filed with NFA' }
    if (p.cftc_activity === 'no')
      return { result: 'not_applicable', reason: 'Auto-dismissed: No commodity/futures/swap activity' }
    if (p.cftc_activity === 'yes_no_exemption')
      return { result: 'needs_review', reason: 'Commodity activity exists but no exemption filed — may need to register or file' }
    return { result: 'needs_review', reason: 'CFTC activity status is unclear' }
  },

  'ca-diversity': (p) => {
    const nexus = p.california_nexus ?? []
    if (nexus.length > 0 && !nexus.includes('none'))
      return { result: 'applies', reason: 'Firm has California nexus' }
    if (nexus.includes('none'))
      return { result: 'not_applicable', reason: 'Auto-dismissed: No California connection' }
    return { result: 'needs_review', reason: 'California nexus has not been assessed' }
  },

  'tax-1065': (p) => {
    if (p.fund_structure === 'lp' || p.fund_structure === 'llc_partnership')
      return { result: 'applies', reason: 'Fund is structured as a partnership' }
    if (p.fund_structure === 'llc_corp')
      return { result: 'not_applicable', reason: 'Auto-dismissed: LLC taxed as corporation' }
    return { result: 'needs_review', reason: 'Fund structure is unclear' }
  },

  'tax-7004': (p) => {
    if (p.fund_structure === 'lp' || p.fund_structure === 'llc_partnership')
      return { result: 'applies', reason: 'Fund is structured as a partnership' }
    if (p.fund_structure === 'llc_corp')
      return { result: 'not_applicable', reason: 'Auto-dismissed: LLC taxed as corporation' }
    return { result: 'needs_review', reason: 'Fund structure is unclear' }
  },

  'quarterly-disclosures': (p) => {
    if (p.registration_status === 'ria' || p.registration_status === 'era')
      return { result: 'applies', reason: 'Required for registered advisers' }
    if (p.registration_status === 'not_registered')
      return { result: 'not_applicable', reason: 'Auto-dismissed: Firm is not registered with the SEC' }
    return { result: 'needs_review', reason: 'Registration status is unclear' }
  },

  'annual-compliance-review': (p) => {
    if (p.registration_status === 'ria')
      return { result: 'applies', reason: 'Required for SEC-registered RIAs' }
    if (p.registration_status === 'era')
      return { result: 'needs_review', reason: 'Not legally required for ERAs, but considered best practice' }
    if (p.registration_status === 'not_registered')
      return { result: 'not_applicable', reason: 'Auto-dismissed: Firm is not registered with the SEC' }
    return { result: 'needs_review', reason: 'Registration status is unclear' }
  },

  'privacy-notice': (p) => {
    if (p.registration_status === 'ria')
      return { result: 'applies', reason: 'Required for SEC-registered RIAs' }
    if (p.registration_status === 'era' || p.registration_status === 'not_registered')
      return { result: 'not_applicable', reason: 'Auto-dismissed: Not required for ERAs or unregistered firms' }
    return { result: 'needs_review', reason: 'Registration status is unclear' }
  },

  'aml-program': (_p) => {
    return { result: 'monitor', reason: 'Effective date postponed to January 1, 2028 — prepare and monitor' }
  },

  'boi-report': (p) => {
    if (p.has_foreign_entities === 'yes')
      return { result: 'applies', reason: 'Fund has foreign-formed entities registered in the U.S.' }
    if (p.has_foreign_entities === 'no')
      return { result: 'not_applicable', reason: 'Auto-dismissed: All entities are U.S.-formed (exempt since March 2025)' }
    return { result: 'needs_review', reason: 'Foreign entity status has not been assessed' }
  },

  'schedule-k1': (p) => {
    if (p.fund_structure === 'lp' || p.fund_structure === 'llc_partnership')
      return { result: 'applies', reason: 'Fund is structured as a partnership — K-1s required for all partners' }
    if (p.fund_structure === 'llc_corp')
      return { result: 'not_applicable', reason: 'Auto-dismissed: LLC taxed as corporation' }
    return { result: 'needs_review', reason: 'Fund structure is unclear' }
  },

  'quarterly-financial-reporting': (_p) => {
    return { result: 'applies', reason: 'Required for all funds with LP reporting obligations per LPA' }
  },

  'lp-capital-statements': (_p) => {
    return { result: 'applies', reason: 'Required for all funds that report capital account balances to LPs' }
  },

  'valuations-soi': (_p) => {
    return { result: 'applies', reason: 'Required for all funds that report NAV or FMV to LPs' }
  },

  'partnership-expenses': (p) => {
    if (p.fund_structure === 'lp' || p.fund_structure === 'llc_partnership')
      return { result: 'applies', reason: 'Fund is a partnership — quarterly expense allocation review recommended per LPA terms' }
    return { result: 'needs_review', reason: 'Fund structure is unclear — review LPA expense provisions' }
  },

  'annual-fund-audit': (_p) => {
    return { result: 'applies', reason: 'Required for most funds per LPA — confirm audit requirement with your LPA' }
  },

  'fatca-crs': (p) => {
    if (p.has_foreign_investors === 'yes')
      return { result: 'applies', reason: 'Fund has foreign (non-U.S.) investors — FATCA withholding and reporting required' }
    if (p.has_foreign_investors === 'no')
      return { result: 'not_applicable', reason: 'Auto-dismissed: All investors are U.S. persons' }
    return { result: 'needs_review', reason: 'Foreign investor status has not been assessed' }
  },

  'insurance-eo': (_p) => {
    return { result: 'needs_review', reason: 'Review whether your firm carries E&O / Professional Liability insurance' }
  },

  'insurance-do': (_p) => {
    return { result: 'needs_review', reason: 'Review whether your firm carries D&O liability insurance' }
  },

  'insurance-cyber': (_p) => {
    return { result: 'needs_review', reason: 'Review whether your firm carries Cyber Liability insurance' }
  },
}

export function evaluateApplicability(
  itemId: string,
  profile: ComplianceProfile
): { result: Applicability; reason: string } {
  const rule = rules[itemId]
  if (!rule) return { result: 'needs_review', reason: 'No applicability rule defined' }
  return rule(profile)
}

export function evaluateAll(
  profile: ComplianceProfile
): Record<string, { result: Applicability; reason: string }> {
  const results: Record<string, { result: Applicability; reason: string }> = {}
  for (const [itemId, rule] of Object.entries(rules)) {
    results[itemId] = rule(profile)
  }
  return results
}
