/**
 * Waste Score — the browser port of `tokenlens/scoring/score.py`.
 *
 * The score is denominated in dollars. An earlier design used fixed weights over
 * bounded [0,1] components (45 overshoot / 35 bloat / 20 zero-value), which was
 * defensible in spirit but ultimately a chosen constant that invites "why 45 and
 * not 40" with no real answer. Pricing overshoot and bloat directly removes the
 * judgement call: the number comes from the same rate sheet the vendor bills
 * against.
 *
 * Two failure modes in that earlier design are now invariants, each with a test:
 *
 * - Using a **cheaper** model than the task required must never produce waste.
 *   The old form went negative there, implying a saving where there was a
 *   quality risk. It is clamped at zero and surfaced as `underProvisioned`.
 * - A **bloated prompt on a correctly chosen model** must still register waste.
 *   The old multiplicative form multiplied bloat by an overshoot of zero, making
 *   half the waste it existed to measure invisible.
 *
 * A third invariant is new: waste can never exceed what was actually spent.
 */

import { BLOAT_METRIC, BloatBaseline, median } from './baseline'
import { isZeroValue, requiredTier } from './classification'
import type { Classification, Complexity } from './classification'
import { cost as costOfTokens, perTokenRate, ZERO } from './money'
import type { Money } from './money'
import { turnTokens } from './models'
import type { Call, Turn } from './models'
import { defaultTable } from './pricing'
import type { PriceTable, Rates } from './pricing'
import { roundHalfEven } from './pyround'

/**
 * Metric-to-rate mapping, so the excess is priced as the same kind of token it
 * actually was.
 */
const RATE_KEY: Record<string, keyof Rates & ('input' | 'cache_read')> = {
  input_tokens: 'input',
  cache_read: 'cache_read',
}

export type Band = 'efficient' | 'moderate' | 'high' | 'critical'

export const BANDS: Band[] = ['efficient', 'moderate', 'high', 'critical']

export const bandFor = (normalized: number): Band => {
  if (normalized <= 20) return 'efficient'
  if (normalized <= 50) return 'moderate'
  if (normalized <= 80) return 'high'
  return 'critical'
}

export interface WasteScoreFields {
  turnId: string
  actualCost: Money
  overshootCost: Money
  bloatCost: Money
  tierUsed: number
  tierRequired: number
  zeroValue?: boolean
  underProvisioned?: boolean
  bloatMeasured?: boolean
  excessTokens?: number
  bloatMetric?: string
  callCount?: number
  callsBaseline?: number | null
}

/** One turn's waste, in dollars, with every component inspectable. */
export class WasteScore {
  readonly turnId: string
  readonly actualCost: Money
  readonly overshootCost: Money
  readonly bloatCost: Money
  readonly tierUsed: number
  readonly tierRequired: number
  readonly zeroValue: boolean
  readonly underProvisioned: boolean
  readonly bloatMeasured: boolean
  readonly excessTokens: number
  readonly bloatMetric: string
  readonly callCount: number
  readonly callsBaseline: number | null

  constructor(fields: WasteScoreFields) {
    this.turnId = fields.turnId
    this.actualCost = fields.actualCost
    this.overshootCost = fields.overshootCost
    this.bloatCost = fields.bloatCost
    this.tierUsed = fields.tierUsed
    this.tierRequired = fields.tierRequired
    this.zeroValue = fields.zeroValue ?? false
    this.underProvisioned = fields.underProvisioned ?? false
    this.bloatMeasured = fields.bloatMeasured ?? true
    this.excessTokens = fields.excessTokens ?? 0
    this.bloatMetric = fields.bloatMetric ?? 'cache_read'
    this.callCount = fields.callCount ?? 1
    this.callsBaseline = fields.callsBaseline ?? null
  }

  /**
   * Dollars that need not have been spent.
   *
   * Busywork forfeits the whole cost: the task did not warrant a model at any
   * tier, so switching to a cheaper one is not the remedy. Otherwise waste is
   * overshoot plus bloat, capped at what was actually spent.
   */
  get estimatedWaste(): Money {
    if (this.zeroValue) return this.actualCost
    const combined = this.overshootCost + this.bloatCost
    return combined < this.actualCost ? combined : this.actualCost
  }

  /** Waste as a percentage of this turn's cost, for ranking and bands. */
  get normalized(): number {
    if (this.actualCost <= ZERO) return 0
    const pct = (Number(this.estimatedWaste) / Number(this.actualCost)) * 100
    return Math.max(0, Math.min(100, Math.trunc(roundHalfEven(pct, 0))))
  }

  get band(): Band {
    return bandFor(this.normalized)
  }

  /**
   * Calls made against calls typical for this difficulty.
   *
   * A diagnostic, not a priced component — the extra calls' cost is already
   * inside `cache_read`, so charging for both would double-count. It explains
   * *why* a turn is bloated.
   */
  get turnEfficiency(): number | null {
    if (!this.callsBaseline) return null
    return this.callCount / this.callsBaseline
  }

  get recommendation(): string {
    if (this.zeroValue) return 'Task did not warrant a model call'
    const parts: string[] = []
    if (this.overshootCost > ZERO) parts.push(`use a tier ${this.tierRequired} model`)
    if (this.bloatCost > ZERO) {
      // en-US explicitly: Python's `{:,}` is locale-independent, and letting the
      // runtime pick would make the text depend on the viewer's machine.
      const excess = this.excessTokens.toLocaleString('en-US')
      parts.push(`trim ${excess} excess ${this.bloatMetric} tokens`)
    }
    if (this.underProvisioned) {
      parts.push('check output quality: model was below the required tier')
    }
    return parts.length ? parts.join('; ') : 'No waste detected'
  }
}

/** Scores turns against a baseline and a rate table. */
export class Scorer {
  private readonly baseline: BloatBaseline
  private readonly table: PriceTable
  private readonly callsBaseline: Map<Complexity, number>

  constructor(
    options: {
      baseline?: BloatBaseline
      table?: PriceTable
      callsBaseline?: Map<Complexity, number>
    } = {},
  ) {
    this.baseline = options.baseline ?? new BloatBaseline()
    this.table = options.table ?? defaultTable()
    this.callsBaseline = options.callsBaseline ?? new Map()
  }

  score(turn: Turn, found: Classification): WasteScore {
    const required = requiredTier(found)

    let actual = ZERO
    let overshoot = ZERO
    const tiers: number[] = []
    let under = false

    for (const call of turn.calls) {
      const cost = this.table.costOf(call)
      actual += cost
      const tier = this.table.tierOf(call.model)
      tiers.push(tier)
      if (tier > required) {
        // Clamped by construction: only a more expensive tier than required can
        // contribute.
        overshoot += cost - this.table.costAtTier(call, required)
      } else if (tier < required) {
        under = true
      }
    }

    const [bloat, excess, measured] = this.bloatFor(turn, found, required)

    return new WasteScore({
      turnId: turn.turn_id,
      actualCost: actual,
      overshootCost: overshoot,
      bloatCost: bloat,
      tierUsed: tiers.length ? Math.max(...tiers) : required,
      tierRequired: required,
      zeroValue: isZeroValue(found),
      underProvisioned: under,
      bloatMeasured: measured,
      excessTokens: excess,
      bloatMetric: BLOAT_METRIC[turn.profile],
      callCount: turn.calls.length,
      callsBaseline: this.callsBaseline.get(found.complexity) ?? null,
    })
  }

  scoreAll(
    turns: Iterable<Turn>,
    classifications: Map<string, Classification>,
  ): WasteScore[] {
    const scores: WasteScore[] = []
    for (const turn of turns) {
      const found = classifications.get(turn.turn_id)
      if (found) scores.push(this.score(turn, found))
    }
    return scores
  }

  /**
   * Cost of tokens beyond what comparable work needed.
   *
   * Priced at the **required** tier, not the tier actually used, so that
   * overshoot and bloat stay disjoint. Overshoot already charges the model-choice
   * delta across every token, including the excess ones; pricing the excess again
   * at the expensive model's rate would bill the same tokens twice and can push
   * reported waste above what was actually spent.
   *
   * With this split the two components sum to exactly
   * `actualCost - idealCost`, where ideal means the required tier at the median
   * volume: overshoot is the model delta at the observed volume, bloat is the
   * volume delta at the correct model.
   */
  private bloatFor(
    turn: Turn,
    found: Classification,
    required: number,
  ): [Money, number, boolean] {
    const reference = this.baseline.medianFor(found.category, found.complexity)
    if (reference === null) return [ZERO, 0, false]

    const metric = BLOAT_METRIC[turn.profile] as keyof Call & string
    const actualTokens = turnTokens(turn, metric)
    // Truncation, not rounding: Python's `int()` on a positive float truncates,
    // and a half-token of excess is not a token.
    const excess = Math.trunc(Math.max(0, actualTokens - reference))
    if (excess === 0 || actualTokens === 0) return [ZERO, 0, true]

    const rates = this.table.ratesFor(
      this.table.referenceModel(required),
      turn.timestamp,
    )
    return [costOfTokens(excess, perTokenRate(rates[RATE_KEY[metric]])), excess, true]
  }
}

/**
 * Median calls per turn, per complexity.
 *
 * Only meaningful for agentic data, where one prompt drives many calls.
 */
export const callsBaselineFrom = (
  turns: Iterable<Turn>,
  classifications: Map<string, Classification>,
  minSamples = 5,
): Map<Complexity, number> => {
  const buckets = new Map<Complexity, number[]>()

  for (const turn of turns) {
    const found = classifications.get(turn.turn_id)
    if (!found || turn.profile !== 'agentic') continue
    if (!buckets.has(found.complexity)) buckets.set(found.complexity, [])
    buckets.get(found.complexity)!.push(turn.calls.length)
  }

  const out = new Map<Complexity, number>()
  for (const [complexity, counts] of buckets) {
    if (counts.length >= minSamples) out.set(complexity, median(counts))
  }
  return out
}
