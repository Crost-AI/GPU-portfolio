// The input of a change to a plan's Investments tab (portfolio construction): the Analyst's staged
// update_portfolio_construction and the direct MCP tool portfolio_construction_update take the same
// shape, applied by the same code (lib/pending-actions/construction.ts).

/** A planned deal's fields (lib/accounting/construction.ts ConstructionStage). */
const STAGE_PROPERTIES = {
  key: { type: 'string', description: 'Stable key; omit on a new deal and one is made from the label.' },
  label: { type: 'string' },
  initialCheck: { type: 'number', minimum: 0 },
  initialPostMoney: { type: 'number', minimum: 0 },
  followOnMultiple: { type: 'number', minimum: 0 },
  followOnCheck: { type: 'number', minimum: 0 },
  dilutionFactor: { type: 'number', minimum: 0 },
  ownershipAtExit: { type: 'number', minimum: 0 },
  additionalDilution: { type: 'number', minimum: 0, maximum: 1 },
  expectedExitValue: { type: 'number', minimum: 0 },
  forecastMoic: { type: 'number', minimum: 0 },
  forecastMoicOverride: { type: 'boolean' },
  returnMethod: { type: 'string', enum: ['ownership', 'moic'] },
  investInYears: { type: ['number', 'null'], minimum: 0, description: 'Years from today the initial check is written.' },
  exitInYears: { type: ['number', 'null'], minimum: 0, description: 'Years from the initial check to the exit.' },
  followOnInYears: { type: ['number', 'null'], minimum: 0, description: 'Years from the initial check to the follow-on.' },
  simLossRate: { type: ['number', 'null'], minimum: 0, maximum: 1 },
  simDispersion: { type: ['number', 'null'], minimum: 0 },
  simExitSpreadYears: { type: ['number', 'null'], minimum: 0 },
} as const

export const UPDATE_CONSTRUCTION_SCHEMA = {
      type: 'object',
      required: ['vehicle'],
      additionalProperties: false,
      properties: {
        vehicle: { type: 'string', description: 'Investment vehicle name.' },
        planId: { type: 'string', description: "The plan (scenario or budget) to change, from forecast_plans. Omit for the entity's primary plan." },
        targetPortfolioSize: { type: 'number', minimum: 0 },
        targetFundMultiple: { type: 'number', minimum: 0 },
        upsertStages: {
          type: 'array',
          description: 'Add planned deals, or change one by its key (others are left alone). A new one needs label and initialCheck.',
          items: { type: 'object', additionalProperties: false, properties: STAGE_PROPERTIES },
        },
        removeStages: { type: 'array', items: { type: 'string' }, description: 'Keys of planned deals to remove.' },
        stages: {
          type: 'array',
          description: 'Replace the whole list of planned deals. Prefer upsertStages/removeStages for one deal.',
          items: {
            type: 'object',
            required: ['key', 'label', 'initialCheck', 'initialPostMoney', 'followOnMultiple', 'dilutionFactor'],
            additionalProperties: false,
            properties: STAGE_PROPERTIES,
          },
        },
        positionForecasts: {
          type: 'object',
          description: 'Changes to companies the fund already holds, keyed by stable company UUID (from portfolio_construction).',
          propertyNames: { format: 'uuid' },
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            properties: {
              plannedFollowOn: { type: 'number', minimum: 0 },
              ownershipAtExit: { type: 'number', minimum: 0 },
              additionalDilution: { type: 'number', minimum: 0, maximum: 1 },
              expectedExitValue: { type: 'number', minimum: 0 },
              forecastMoic: { type: 'number', minimum: 0 },
              forecastMoicOverride: { type: 'boolean', description: 'true makes forecastMoic stick, including 0 (a write-off).' },
              returnMethod: { type: 'string', enum: ['ownership', 'moic'] },
              exitInYears: { type: ['number', 'null'], minimum: 0, description: 'Hold period: years from the company\'s first investment to its exit (from today if that date is unknown); null = the fund-wide hold.' },
              followOnInYears: { type: ['number', 'null'], minimum: 0, description: 'Years from today to the follow-on.' },
              simLossRate: { type: ['number', 'null'], minimum: 0, maximum: 1 },
              simDispersion: { type: ['number', 'null'], minimum: 0 },
              simExitSpreadYears: { type: ['number', 'null'], minimum: 0 },
            },
          },
        },
        returnAssumptions: {
          type: 'object',
          additionalProperties: false,
          description: "The fund-wide return assumptions (the page's Return assumptions): used for any deal without its own, and to vary exits in the simulation.",
          properties: {
            holdYears: { type: 'number', minimum: 0, maximum: 30, description: 'Default years from investment to exit.' },
            defaultExitMultiple: { type: 'number', minimum: 0, description: 'Exit multiple for a deal with none of its own.' },
            lossRate: { type: 'number', minimum: 0, maximum: 0.99, description: 'Share of planned deals the simulation writes off. Held companies are written off only on their own simLossRate.' },
            exitTimingRangeYears: { type: 'number', minimum: 0, maximum: 20, description: 'Years either side of the expected exit the simulation varies timing.' },
            dispersion: { type: 'number', minimum: 0, maximum: 5, description: 'Spread of simulated exit values (log-normal sigma).' },
          },
        },
        explanation: { type: 'string', description: 'Optional explanation supplied by the user.' },
      },
    } as const
