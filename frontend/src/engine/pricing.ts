/**
 * Cache-aware cost engine — the browser port of `tokenlens/pricing.py`.
 *
 * Real agentic usage is dominated by cache traffic, not fresh input: across the
 * reference dataset, cache reads were 59% of spend, cache writes 33%, output 7%,
 * and uncached input 0.0%. A cost engine that only prices `input_tokens` and
 * `output_tokens` is therefore not slightly off, it is wrong by orders of
 * magnitude. Every token category is priced separately here, and cache writes
 * are split by TTL because the 1-hour tier costs 2x base against the 5-minute
 * tier's 1.25x.
 *
 * Money is exact `Money` (pico-dollars) throughout — see `money.ts` for why
 * `number` is not usable. Rates come from `rates.json`, generated from
 * `pricing.yaml` by `backend/scripts/export_rates.py`, and carry the same
 * version and date so a figure can always be traced to the table that produced
 * it.
 */

import { cost as costOfTokens, parseMoney, perTokenRate, sum } from './money'
import type { Money } from './money'
import type { Call } from './models'
import rateTableData from './rates.json'

/**
 * The token categories the engine prices. Each maps to a field on `Call` and a
 * rate key in the table, which keeps the two in lockstep.
 */
export const TOKEN_CATEGORIES = [
  'input_tokens',
  'output_tokens',
  'cache_read',
  'cache_write_5m',
  'cache_write_1h',
] as const

export type TokenCategory = (typeof TOKEN_CATEGORIES)[number]

type RateKey = 'input' | 'output' | 'cache_read' | 'cache_write_5m' | 'cache_write_1h'

const RATE_KEY: Record<TokenCategory, RateKey> = {
  input_tokens: 'input',
  output_tokens: 'output',
  cache_read: 'cache_read',
  cache_write_5m: 'cache_write_5m',
  cache_write_1h: 'cache_write_1h',
}

/**
 * Raised when a model has no rate entry and no prefix fallback.
 *
 * Deliberately loud: silently pricing an unknown model at zero would understate
 * spend without any visible symptom.
 */
export class UnknownModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnknownModelError'
  }
}

interface RateSet {
  input: string
  output: string
  cache_read: string
  cache_write_5m: string
  cache_write_1h: string
}

interface ModelEntry extends RateSet {
  tier: number
  promotional?: RateSet & { until: string }
}

export interface RateTableData {
  version: number
  updated: string
  currency: string
  models: Record<string, ModelEntry>
  tier_reference: Record<string, string>
  prefix_fallbacks: Record<string, string>
}

/** Per-million-token rates for one model at one point in time. */
export interface Rates {
  model: string
  tier: number
  input: Money
  output: Money
  cache_read: Money
  cache_write_5m: Money
  cache_write_1h: Money
  promotional: boolean
}

export const rateFor = (rates: Rates, category: TokenCategory): Money =>
  rates[RATE_KEY[category]]

/**
 * The calendar date a `Date` falls on in UTC.
 *
 * UTC rather than local: promotional windows are provider-side billing periods,
 * and the same instant must not land inside the window for one viewer and
 * outside it for another just because their machines disagree about midnight.
 */
const utcDate = (value: Date): string => value.toISOString().slice(0, 10)

/** A loaded, dated rate table. */
export class PriceTable {
  readonly version: number
  /** ISO date. Kept as a string because that is also its wire format. */
  readonly updated: string
  readonly currency: string

  private readonly models: Record<string, ModelEntry>
  private readonly tierReference: Map<number, string>
  private readonly prefixes: [string, string][]

  constructor(data: RateTableData) {
    this.version = data.version
    this.updated = data.updated
    this.currency = data.currency ?? 'USD'
    this.models = data.models
    this.tierReference = new Map(
      Object.entries(data.tier_reference ?? {}).map(([tier, model]) => [
        Number(tier),
        model,
      ]),
    )
    // Longest prefix first, so `gpt-4o-mini` wins over `gpt-4o`.
    this.prefixes = Object.entries(data.prefix_fallbacks ?? {}).sort(
      ([a], [b]) => b.length - a.length,
    )
  }

  static load(data: RateTableData = rateTableData as RateTableData): PriceTable {
    return new PriceTable(data)
  }

  /** Map a model id to the table entry that prices it. */
  resolve(model: string): string {
    if (model in this.models) return model
    for (const [prefix, target] of this.prefixes) {
      if (model.startsWith(prefix)) return target
    }
    throw new UnknownModelError(
      `no rate entry or prefix fallback for model '${model}'; ` +
        `add it to the rate table (version ${this.version}, updated ${this.updated})`,
    )
  }

  /**
   * Rates for `model`, applying any promotional window active at `at`.
   *
   * `at` is the moment the call was billed. When it is unknown, list rates
   * apply — a time-limited discount is never assumed, since guessing wrong
   * understates real spend.
   */
  ratesFor(model: string, at: Date | null = null): Rates {
    const entry = this.models[this.resolve(model)]
    const promo = entry.promotional
    const usePromo = Boolean(promo && at && utcDate(at) <= promo.until)

    const source: RateSet = usePromo ? { ...entry, ...promo! } : entry
    return {
      model,
      // Read from `entry`, not `source`: a discount changes the price of a tier,
      // never which tier the model belongs to.
      tier: Number(entry.tier),
      input: parseMoney(source.input),
      output: parseMoney(source.output),
      cache_read: parseMoney(source.cache_read),
      cache_write_5m: parseMoney(source.cache_write_5m),
      cache_write_1h: parseMoney(source.cache_write_1h),
      promotional: usePromo,
    }
  }

  tierOf(model: string): number {
    return Number(this.models[this.resolve(model)].tier)
  }

  /** Total cost of one call, summed across every token category. */
  costOf(call: Call): Money {
    const rates = this.ratesFor(call.model, call.timestamp)
    return sum(
      TOKEN_CATEGORIES.map((category) =>
        costOfTokens(call[category], perTokenRate(rateFor(rates, category))),
      ),
    )
  }

  /**
   * Cost of one call split by token category.
   *
   * This is what makes the composition claim inspectable rather than asserted —
   * the caller can show where the money actually went.
   */
  costBreakdown(call: Call): Record<TokenCategory, Money> {
    const rates = this.ratesFor(call.model, call.timestamp)
    const breakdown = {} as Record<TokenCategory, Money>
    for (const category of TOKEN_CATEGORIES) {
      breakdown[category] = costOfTokens(
        call[category],
        perTokenRate(rateFor(rates, category)),
      )
    }
    return breakdown
  }

  /** The model a tier is priced against for counterfactual costing. */
  referenceModel(tier: number): string {
    const model = this.tierReference.get(tier)
    if (!model) {
      throw new UnknownModelError(`no reference model configured for tier ${tier}`)
    }
    return model
  }

  /**
   * What this call's tokens would have cost on the given tier.
   *
   * The whole call is repriced, not just its input, because output is a material
   * share of cost and is charged at a different multiple on every model. Token
   * counts are held constant: this answers "the same work on a cheaper model",
   * not "a cheaper model would have produced less".
   */
  costAtTier(call: Call, tier: number): Money {
    return this.costOf({ ...call, model: this.referenceModel(tier) })
  }
}

let cached: PriceTable | null = null

/** The bundled rate table, loaded once. */
export const defaultTable = (): PriceTable => (cached ??= PriceTable.load())

export const costOf = (call: Call): Money => defaultTable().costOf(call)

export const costBreakdown = (call: Call): Record<TokenCategory, Money> =>
  defaultTable().costBreakdown(call)

export const tierOf = (model: string): number => defaultTable().tierOf(model)
