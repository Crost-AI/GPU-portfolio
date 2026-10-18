// GPU_Fund_Model_v3 (the "pack"): inputs, a pure annual operating model, and the expected
// waterfall tables from the pivot plan §3.10. The waterfall tests assert against these, and the
// scenario engine (P4) asserts its own output against `packDistributableCash`, so the two can
// never disagree about what the pack says.
//
// Expected figures are the pack's whole dollars unless named `...Cents`. Tolerances (plan §3.10):
// per-year ±$1, IRR 0.1pp after rounding to one decimal, multiple 0.01×; the §3.4 identity exact.

import type { CashWaterfallTerms } from '../waterfall'
import { roundCents } from '@/lib/accounting/ledger'

export type PackServer = 'h200_nvl' | 'b200' | 'b300'
export const PACK_SERVERS: PackServer[] = ['h200_nvl', 'b200', 'b300']

export const PACK_INPUTS = {
  servers: {
    h200_nvl: { cost: 335_000, anchorRate: 4.5, gpus: 8 },
    b200: { cost: 410_000, anchorRate: 5.5, gpus: 8 },
    b300: { cost: 560_000, anchorRate: 9, gpus: 8 },
  } satisfies Record<PackServer, { cost: number; anchorRate: number; gpus: number }>,
  hardwareCost: 1_305_000,
  /** 1.10 × hardware: the contingency is raised with the capital. */
  capital: 1_435_500,
  hoursPerYear: 8_760,
  datacenterMonthly: 10_280,
  /** Compounding, from Y2. */
  datacenterGrowth: 0.05,
  /** On the datacenter line, every year. */
  contingencyRate: 0.1,
  processingRate: 0.01,
  /** Of hardware cost, a year: $13,050. */
  insuranceRate: 0.01,
  feeRate: 0.05,
  /** Half of a year's price change lands in that year's average rate. */
  midYear: 0.5,
  years: 5,
  /** Book value (10% salvage) on the last day of Y5. */
  salePrice: 130_500,
} as const

export interface PackScenario {
  label: string
  utilization: number
  /** Price change g_y for Y1..Y5, per server. */
  priceChanges: Record<PackServer, number[]>
}

const flat = (g: number[]): Record<PackServer, number[]> => ({ h200_nvl: g, b200: g, b300: g })
const OVERSUPPLY_PATHS: Record<PackServer, number[]> = {
  h200_nvl: [-0.15, -0.2, -0.15, -0.15, -0.15],
  b200: [-0.2, -0.2, -0.2, -0.2, -0.2],
  b300: [-0.2, -0.2, -0.2, -0.2, -0.2],
}

export const PACK_SCENARIOS = {
  base: { label: 'Base case', utilization: 0.75, priceChanges: flat([-0.05, -0.05, -0.05, -0.05, -0.05]) },
  balanced: { label: 'Balanced', utilization: 0.75, priceChanges: flat([0, 0, 0, 0, 0]) },
  demand_led: {
    label: 'Demand-led',
    utilization: 0.75,
    priceChanges: { h200_nvl: [0.15, 0.1, 0, 0, 0], b200: [0.15, 0.1, 0, 0, 0], b300: [0.25, 0.15, 0, 0, 0] },
  },
  oversupply: { label: 'Oversupply', utilization: 0.75, priceChanges: OVERSUPPLY_PATHS },
  oversupply_60: { label: 'Oversupply, 60% util', utilization: 0.6, priceChanges: OVERSUPPLY_PATHS },
  oversupply_50: { label: 'Oversupply, 50% util', utilization: 0.5, priceChanges: OVERSUPPLY_PATHS },
} satisfies Record<string, PackScenario>

export type PackScenarioId = keyof typeof PACK_SCENARIOS

/** The pack's waterfall on its annual cadence: one distribution a year, `periodFraction` 1. */
export const PACK_MANAGER = 'manager'
export const PACK_TERMS: CashWaterfallTerms = {
  prefRate: 0.08,
  dayCount: 'periodic',
  rocLpShare: 1,
  carryRate: 0.3,
  recipients: [{ lpEntityId: PACK_MANAGER, pct: 100 }],
}

/** $/GPU-hour in year y (1-based): anchor × Π_{k<y}(1+g_k) × (1 + 0.5·g_y). Unrounded. */
export function packRate(scenario: PackScenario, server: PackServer, year: number): number {
  const g = scenario.priceChanges[server]
  let rate = PACK_INPUTS.servers[server].anchorRate
  for (let k = 0; k < year - 1; k++) rate *= 1 + g[k]
  return rate * (1 + PACK_INPUTS.midYear * g[year - 1])
}

export interface PackYear {
  year: number
  revenue: number
  revenueByType: Record<PackServer, number>
  datacenter: number
  contingency: number
  processing: number
  insurance: number
  operatingProfit: number
  fee: number
  sale: number
  /** Operating profit − fee + sale: what the waterfall distributes. */
  distributable: number
}

/**
 * The pack's annual operating model for one scenario, Y1..Y5, in cents.
 *
 * Every figure is computed unrounded, exactly as the spreadsheet does, and rounded to cents once
 * at the end. So the rounded fields need not sum to the cent: Base Y5 `distributable` is
 * 697,990.41, where summing the rounded lines gives .40.
 */
export function packDistributableCash(scenario: PackScenario | PackScenarioId): PackYear[] {
  const s = typeof scenario === 'string' ? PACK_SCENARIOS[scenario] : scenario
  const p = PACK_INPUTS
  const out: PackYear[] = []
  for (let year = 1; year <= p.years; year++) {
    const byType = Object.fromEntries(PACK_SERVERS.map(server => [
      server,
      p.servers[server].gpus * packRate(s, server, year) * p.hoursPerYear * s.utilization,
    ])) as Record<PackServer, number>
    const revenue = PACK_SERVERS.reduce((t, server) => t + byType[server], 0)
    const datacenter = p.datacenterMonthly * 12 * Math.pow(1 + p.datacenterGrowth, year - 1)
    const contingency = datacenter * p.contingencyRate
    const processing = revenue * p.processingRate
    const insurance = p.hardwareCost * p.insuranceRate
    const operatingProfit = revenue - datacenter - contingency - processing - insurance
    const fee = revenue * p.feeRate
    const sale = year === p.years ? p.salePrice : 0
    out.push({
      year,
      revenue: roundCents(revenue),
      revenueByType: Object.fromEntries(PACK_SERVERS.map(server => [server, roundCents(byType[server])])) as Record<PackServer, number>,
      datacenter: roundCents(datacenter),
      contingency: roundCents(contingency),
      processing: roundCents(processing),
      insurance: roundCents(insurance),
      operatingProfit: roundCents(operatingProfit),
      fee: roundCents(fee),
      sale,
      distributable: roundCents(operatingProfit - fee + sale),
    })
  }
  return out
}

// ── Expected values (plan §3.10) ────────────────────────────────────────────────────────────

export interface ExpectedYear {
  revenue: number
  operatingProfit: number
  sale: number
  fee: number
  distributable: number
  unreturnedStart: number
  pref: number
  prefCarriedForward: number
  roc: number
  profitToLP: number
  carry: number
  toLP: number
  toManager: number
}

const row = (...v: number[]): ExpectedYear => {
  const [revenue, operatingProfit, sale, fee, distributable, unreturnedStart, pref, prefCarriedForward, roc, profitToLP, carry, toLP, toManager] = v
  return { revenue, operatingProfit, sale, fee, distributable, unreturnedStart, pref, prefCarriedForward, roc, profitToLP, carry, toLP, toManager }
}

/** F1: Base case, the primary fixture. */
export const F1 = {
  scenario: 'base' as PackScenarioId,
  years: [
    row(973_674, 815_191, 0, 48_684, 766_508, 1_435_500, 114_840, 0, 651_668, 0, 0, 766_508, 48_684),
    row(924_990, 760_210, 0, 46_250, 713_960, 783_832, 62_707, 0, 651_253, 0, 0, 713_960, 46_250),
    row(878_741, 707_299, 0, 43_937, 663_361, 132_579, 10_606, 0, 132_579, 364_123, 156_053, 507_309, 199_990),
    row(834_804, 656_321, 0, 41_740, 614_580, 0, 0, 0, 0, 430_206, 184_374, 430_206, 226_114),
    row(793_064, 607_144, 130_500, 39_653, 697_990, 0, 0, 0, 0, 488_593, 209_397, 488_593, 249_050),
  ],
  totals: {
    revenue: 4_405_272, operatingProfit: 3_546_164, sale: 130_500, fee: 220_264, distributable: 3_456_400,
    pref: 188_153, roc: 1_435_500, profitToLP: 1_282_923, carry: 549_824, toLP: 2_906_576, toManager: 770_088,
  },
  revenueByType: {
    y1: { h200_nvl: 230_607, b200: 281_853, b300: 461_214 },
    y5: { h200_nvl: 187_831, b200: 229_571, b300: 375_662 },
  },
  datacenter: [123_360, 129_528, 136_004, 142_805, 149_945],
  contingency: [12_336, 12_953, 13_600, 14_280, 14_994],
  processing: [9_737, 9_250, 8_787, 8_348, 7_931],
  insurance: 13_050,
  y5Rates: { h200_nvl: 3.57, b200: 4.37, b300: 7.15 },
  distributableCents: [766_507.56, 713_960.08, 663_361.5, 614_580.44, 697_990.41],
  y3Cents: { pref: 10_606.32, roc: 132_578.96, carry: 156_052.87, profitToLP: 364_123.35 },
  irrPct: 33.6,
  multiple: 2.02,
  unreturnedAtClose: 0,
}

/** F2: Oversupply, 60% utilisation. */
export const F2 = {
  scenario: 'oversupply_60' as PackScenarioId,
  years: [
    row(723_751, 567_768, 0, 36_188, 531_580, 1_435_500, 114_840, 0, 416_740, 0, 0, 531_580, 36_188),
    row(583_731, 422_363, 0, 29_187, 393_177, 1_018_760, 81_501, 0, 311_676, 0, 0, 393_177, 29_187),
    row(470_202, 302_845, 0, 23_510, 279_335, 707_084, 56_567, 0, 222_768, 0, 0, 279_335, 23_510),
    row(382_112, 208_156, 0, 19_106, 189_050, 484_316, 38_745, 0, 150_305, 0, 0, 189_050, 19_106),
    row(310_748, 129_651, 130_500, 15_537, 244_614, 334_011, 26_721, 0, 217_893, 0, 0, 244_614, 15_537),
  ],
  totals: { toLP: 1_637_756, fee: 123_527, pref: 318_374, roc: 1_319_382 },
  unreturnedAtClose: 116_118,
  irrPct: 5.5,
  multiple: 1.14,
}

/** F3: Oversupply, 50% utilisation. */
export const F3 = {
  scenario: 'oversupply_50' as PackScenarioId,
  years: [
    row(603_126, 448_349, 0, 30_156, 418_192, 1_435_500, 114_840, 0, 303_352, 0, 0, 418_192, 30_156),
    row(486_443, 326_048, 0, 24_322, 301_725, 1_132_148, 90_572, 0, 211_154, 0, 0, 301_725, 24_322),
    row(391_835, 225_262, 0, 19_592, 205_670, 920_994, 73_680, 0, 131_990, 0, 0, 205_670, 19_592),
    row(318_427, 145_108, 0, 15_921, 129_186, 789_004, 63_120, 0, 66_066, 0, 0, 129_186, 15_921),
    row(258_957, 78_378, 130_500, 12_948, 195_930, 722_938, 57_835, 0, 138_095, 0, 0, 195_930, 12_948),
  ],
  totals: { toLP: 1_250_704, fee: 102_939, pref: 400_047, roc: 850_657 },
  unreturnedAtClose: 584_843,
  irrPct: -5.2,
  multiple: 0.87,
}

export interface ExpectedScenario {
  scenario: PackScenarioId
  fee: number[]
  pref: number[]
  roc: number[]
  profitToLP: number[]
  carry: number[]
  toLP: number[]
  totalToLP: number
  multiple: number
  irrPct: number
}

/** F4: the other three scenarios, Y1..Y5 (zero where the pack shows nothing). */
export const F4: Record<'balanced' | 'demand_led' | 'oversupply', ExpectedScenario> = {
  balanced: {
    scenario: 'balanced',
    fee: [49_932, 49_932, 49_932, 49_932, 49_932],
    pref: [114_840, 60_829, 3_040, 0, 0],
    roc: [675_136, 722_362, 38_003, 0, 0],
    profitToLP: [0, 0, 514_517, 538_011, 623_863],
    carry: [0, 0, 220_507, 230_576, 267_370],
    toLP: [789_976, 783_191, 555_560, 538_011, 623_863],
    totalToLP: 3_290_599,
    multiple: 2.29,
    irrPct: 39.4,
  },
  demand_led: {
    scenario: 'demand_led',
    fee: [54_860, 63_515, 67_244, 67_244, 67_244],
    pref: [114_840, 53_418, 0, 0, 0],
    roc: [767_773, 667_727, 0, 0, 0],
    profitToLP: [0, 222_190, 771_072, 765_836, 851_688],
    carry: [0, 95_224, 330_459, 328_215, 365_009],
    toLP: [882_613, 943_336, 771_072, 765_836, 851_688],
    totalToLP: 4_214_544,
    multiple: 2.94,
    irrPct: 53.0,
  },
  oversupply: {
    scenario: 'oversupply',
    fee: [45_234, 36_483, 29_388, 23_882, 19_422],
    pref: [114_840, 67_894, 30_898, 2_183, 0],
    roc: [586_822, 462_459, 358_935, 27_284, 0],
    profitToLP: [0, 0, 0, 174_566, 222_348],
    carry: [0, 0, 0, 74_814, 95_292],
    toLP: [701_662, 530_354, 389_832, 204_033, 222_348],
    totalToLP: 2_048_228,
    multiple: 1.43,
    irrPct: 17.2,
  },
}

/** F5: synthetic pref shortfall, carried forward without compounding. Cents exact. */
export const F5 = {
  distributions: [50_000, 300_000, 2_000_000],
  years: [
    { prefDue: 114_840, preferred: 50_000, prefCarriedForward: 64_840, roc: 0, unreturnedAfter: 1_435_500, profitToLP: 0, carry: 0 },
    { prefDue: 179_680, preferred: 179_680, prefCarriedForward: 0, roc: 120_320, unreturnedAfter: 1_315_180, profitToLP: 0, carry: 0 },
    { prefDue: 105_214.4, preferred: 105_214.4, prefCarriedForward: 0, roc: 1_315_180, unreturnedAfter: 0, profitToLP: 405_723.92, carry: 173_881.68 },
  ],
}

/** F6: two investors on the Base cents distributions. Cents exact. */
export const F6 = {
  investors: [{ lpEntityId: 'A', amount: 1_000_000 }, { lpEntityId: 'B', amount: 435_500 }],
  years: [
    { pref: [80_000, 34_840], roc: [453_965.56, 197_702], unreturnedAfter: [546_034.44, 237_798], profit: [0, 0], carry: 0 },
    { pref: [43_682.76, 19_023.84], roc: [453_677.1, 197_576.38], unreturnedAfter: [92_357.34, 40_221.62], profit: [0, 0], carry: 0 },
    { pref: [7_388.59, 3_217.73], roc: [92_357.34, 40_221.62], unreturnedAfter: [0, 0], profit: [253_656.11, 110_467.24], carry: 156_052.87 },
  ],
}

/** F8: the Base flows as dated events. 30/360 reproduces F1; ACT/365 shows the 2028 leap year. */
export const F8 = {
  contributionDate: '2027-01-01',
  distributionDates: ['2028-01-01', '2029-01-01', '2030-01-01', '2031-01-01', '2032-01-01'],
  /** roundCents(783,832.44 × 0.08 × 366/365). */
  act365Y2PrefCents: 62_878.39,
}
