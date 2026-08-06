/**
 * Analysis payload — the browser port of `tokenlens/analysis.py`.
 *
 * Aggregates priced turns into the exact structure the dashboard already
 * renders, so a CSV read in this tab and a JSONL read by the CLI produce the
 * same shape and the same components draw both.
 *
 * Two properties carry over from the Python and drive the design:
 *
 * Money is serialized as a decimal string, never a JSON number. A float
 * round-trip would silently perturb figures the project asks people to trust.
 *
 * Spend analysis and waste analysis are separated. Composition, per-model cost
 * and turn shape need no classification and are always available. Waste requires
 * classified prompts, so it is a nullable section — rather than rendering zeros
 * that read as "no waste found" when the truth is "not yet measured". Scoring is
 * not ported yet, so `waste` is always null here; the field exists so the
 * payload is a complete `Analysis` rather than a lookalike.
 */

import { BloatBaseline } from './baseline'
import {
  complexityChangedOnEscalation,
  isHuman,
  requiredTier,
} from './classification'
import type { Classification } from './classification'
import { formatMoney, sum, ZERO } from './money'
import type { Money } from './money'
import { isScorable, totalTokens } from './models'
import type { Call, Turn } from './models'
import { TOKEN_CATEGORIES, defaultTable } from './pricing'
import type { PriceTable, TokenCategory } from './pricing'
import { roundHalfEven } from './pyround'
import { BANDS, Scorer, callsBaselineFrom } from './score'
import type { WasteScore } from './score'
import type {
  Analysis,
  BandRow,
  CategoryRow,
  HeatmapCell,
  LeaderboardRow,
  ModelRow,
  TokenCategoryRow,
  Waste,
} from '../types'

export { roundHalfEven }

/** Ordered for display: how agentic spend actually breaks down. */
const CATEGORY_ORDER: TokenCategory[] = [
  'cache_read',
  'cache_write_1h',
  'cache_write_5m',
  'output_tokens',
  'input_tokens',
]

const CATEGORY_LABELS: Record<TokenCategory, string> = {
  cache_read: 'cache read',
  cache_write_1h: 'cache write (1h)',
  cache_write_5m: 'cache write (5m)',
  output_tokens: 'output',
  input_tokens: 'input (uncached)',
}

const share = (part: Money, whole: Money): number =>
  whole <= ZERO ? 0 : roundHalfEven(Number(part) / Number(whole), 4)

const eachCall = function* (turns: Turn[]): Generator<Call> {
  for (const turn of turns) yield* turn.calls
}

/** Cost descending, first-seen order preserved on ties — Python's `most_common`. */
const byCostDescending = <T extends { cost: Money }>(rows: T[]): T[] =>
  // Array.prototype.sort is stable, which is what makes the tie behaviour match.
  [...rows].sort((a, b) => (b.cost > a.cost ? 1 : b.cost < a.cost ? -1 : 0))

export interface PriceableTurns {
  turns: Turn[]
  /** Calls dropped because no rate entry covers their model. */
  droppedCalls: number
  droppedModels: string[]
}

/**
 * Drop calls the rate table cannot price.
 *
 * `buildAnalysis` raises on an unknown model, matching the Python, because
 * pricing one at zero would understate spend invisibly. That is the right
 * default for a CLI reading logs it produced itself, and the wrong experience
 * for a browser handed an arbitrary export — so the filtering happens here,
 * explicitly and with a count, rather than by softening the engine.
 */
export const withPriceableCalls = (
  turns: Turn[],
  table: PriceTable = defaultTable(),
): PriceableTurns => {
  const unknown = new Set<string>()
  const resolvable = new Map<string, boolean>()
  let droppedCalls = 0

  const canPrice = (model: string): boolean => {
    let known = resolvable.get(model)
    if (known === undefined) {
      try {
        table.resolve(model)
        known = true
      } catch {
        known = false
        unknown.add(model)
      }
      resolvable.set(model, known)
    }
    return known
  }

  const kept: Turn[] = []
  for (const turn of turns) {
    const calls = turn.calls.filter((call) => {
      if (canPrice(call.model)) return true
      droppedCalls += 1
      return false
    })
    // A turn with every call dropped produced no priceable spend and no shape
    // worth reporting; keeping it would skew calls-per-turn toward zero.
    if (calls.length) kept.push(calls.length === turn.calls.length ? turn : { ...turn, calls })
  }

  return { turns: kept, droppedCalls, droppedModels: [...unknown] }
}

export interface AnalysisOptions {
  table?: PriceTable
  /** Keyed by turn id. Absent turns are simply not scored. */
  classifications?: Map<string, Classification>
  scores?: WasteScore[]
}

/**
 * Score every classified turn, wiring up both baselines from the corpus.
 *
 * Mirrors what `build_analysis` does in Python: the bloat reference and the
 * calls-per-turn reference are derived from the same turns being scored, so the
 * comparison is always against your own comparable work.
 */
export const scoreTurns = (
  turns: Turn[],
  classifications: Map<string, Classification>,
  table: PriceTable = defaultTable(),
): { scores: WasteScore[]; baseline: BloatBaseline } => {
  const baseline = BloatBaseline.fromTurns(turns, classifications)
  const scorer = new Scorer({
    baseline,
    table,
    callsBaseline: callsBaselineFrom(turns, classifications),
  })
  return { scores: scorer.scoreAll(turns, classifications), baseline }
}

/** Aggregate priced turns into the dashboard payload. */
export const buildAnalysis = (
  turns: Turn[],
  options: AnalysisOptions = {},
): Analysis => {
  const table = options.table ?? defaultTable()
  const classifications = options.classifications ?? new Map<string, Classification>()
  const scores = options.scores ?? []

  const calls = [...eachCall(turns)]
  const total = sum(calls.map((call) => table.costOf(call)))

  return {
    generated_at: new Date().toISOString(),
    rate_table: {
      version: table.version,
      updated: table.updated,
      currency: table.currency,
    },
    overview: {
      total_cost: formatMoney(total),
      turns: turns.length,
      scorable_turns: turns.filter(isScorable).length,
      classified_turns: classifications.size,
      calls: calls.length,
      mean_calls_per_turn: turns.length
        ? roundHalfEven(calls.length / turns.length, 2)
        : 0,
      total_tokens: calls.reduce((count, call) => count + totalTokens(call), 0),
      sessions: new Set(
        turns.map((turn) => turn.session_id).filter((id): id is string => Boolean(id)),
      ).size,
    },
    cost_by_token_category: byTokenCategory(calls, total, table),
    cost_by_model: byModel(calls, total, table),
    calls_per_turn: callsPerTurn(turns),
    waste: buildWaste(turns, classifications, scores),
  }
}

/**
 * The waste section, or null when nothing has been scored.
 *
 * Null rather than a structure full of zeros: zeros read as "no waste found"
 * when the truth is "not yet measured", and that difference is the whole reason
 * this section is separated from spend in the first place.
 */
const buildWaste = (
  turns: Turn[],
  classifications: Map<string, Classification>,
  scores: WasteScore[],
): Waste | null => {
  if (!scores.length) return null

  const byId = new Map(turns.map((turn) => [turn.turn_id, turn]))
  const totalWaste = sum(scores.map((score) => score.estimatedWaste))
  const scoredCost = sum(scores.map((score) => score.actualCost))

  return {
    total_waste: formatMoney(totalWaste),
    scored_cost: formatMoney(scoredCost),
    waste_share: share(totalWaste, scoredCost),
    scored_turns: scores.length,
    unmeasured_bloat_turns: scores.filter((score) => !score.bloatMeasured).length,
    // The dashboard says which produced these figures, so a hand-labelled run is
    // never mistaken for a classified one.
    source: classificationSource(classifications, scores),
    components: {
      overshoot: formatMoney(sum(scores.map((score) => score.overshootCost))),
      bloat: formatMoney(sum(scores.map((score) => score.bloatCost))),
      zero_value_cost: formatMoney(
        sum(scores.filter((score) => score.zeroValue).map((score) => score.actualCost)),
      ),
    },
    bands: bands(scores),
    complexity_by_tier: heatmap(classifications, scores),
    category_distribution: distribution(classifications, scores),
    leaderboard: leaderboard(byId, classifications, scores),
    flags: {
      under_provisioned: scores.filter((score) => score.underProvisioned).length,
      zero_value: scores.filter((score) => score.zeroValue).length,
      escalated: [...classifications.values()].filter((found) => found.escalated).length,
      escalation_changed_tier: [...classifications.values()].filter(
        complexityChangedOnEscalation,
      ).length,
    },
  }
}

/** Where the labels behind the waste figures came from. */
const classificationSource = (
  classifications: Map<string, Classification>,
  scores: WasteScore[],
): Waste['source'] => {
  const scoredIds = new Set(scores.map((score) => score.turnId))
  let human = 0
  for (const [turnId, found] of classifications) {
    if (scoredIds.has(turnId) && isHuman(found)) human += 1
  }
  if (!human) return 'classifier'
  return human === scoredIds.size ? 'hand-labelled' : 'mixed'
}

const bands = (scores: WasteScore[]): BandRow[] => {
  const counts = new Map<string, number>()
  const costs = new Map<string, Money>()
  for (const score of scores) {
    counts.set(score.band, (counts.get(score.band) ?? 0) + 1)
    costs.set(score.band, (costs.get(score.band) ?? ZERO) + score.actualCost)
  }
  // Fixed order, every band present: a band with no turns is a real finding, and
  // dropping the row would make the distribution unreadable.
  return BANDS.map((band) => ({
    band,
    turns: counts.get(band) ?? 0,
    cost: formatMoney(costs.get(band) ?? ZERO),
  }))
}

/** Complexity against tier used. The waste lives above the diagonal. */
const heatmap = (
  classifications: Map<string, Classification>,
  scores: WasteScore[],
): HeatmapCell[] => {
  interface Cell {
    complexity: string
    required_tier: number
    tier_used: number
    turns: number
    cost: Money
    waste: Money
  }
  const cells = new Map<string, Cell>()

  for (const score of scores) {
    const found = classifications.get(score.turnId)!
    const key = `${found.complexity}|${score.tierUsed}`
    let cell = cells.get(key)
    if (!cell) {
      cell = {
        complexity: found.complexity,
        required_tier: requiredTier(found),
        tier_used: score.tierUsed,
        turns: 0,
        cost: ZERO,
        waste: ZERO,
      }
      cells.set(key, cell)
    }
    cell.turns += 1
    cell.cost += score.actualCost
    cell.waste += score.estimatedWaste
  }

  return [...cells.values()]
    .sort((a, b) => a.required_tier - b.required_tier || a.tier_used - b.tier_used)
    .map((cell) => ({
      complexity: cell.complexity,
      required_tier: cell.required_tier,
      tier_used: cell.tier_used,
      turns: cell.turns,
      cost: formatMoney(cell.cost),
      waste: formatMoney(cell.waste),
    }))
}

const distribution = (
  classifications: Map<string, Classification>,
  scores: WasteScore[],
): CategoryRow[] => {
  const costs = new Map<string, Money>()
  const counts = new Map<string, number>()
  for (const score of scores) {
    const category = classifications.get(score.turnId)!.category
    costs.set(category, (costs.get(category) ?? ZERO) + score.actualCost)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return byCostDescending([...costs].map(([category, cost]) => ({ category, cost }))).map(
    ({ category, cost }) => ({
      category,
      turns: counts.get(category) ?? 0,
      cost: formatMoney(cost),
    }),
  )
}

const LEADERBOARD_LIMIT = 20

const leaderboard = (
  byId: Map<string, Turn>,
  classifications: Map<string, Classification>,
  scores: WasteScore[],
): LeaderboardRow[] =>
  [...scores]
    // Stable, so equal-waste turns keep corpus order rather than shuffling
    // between runs — the same property Python's `sorted(..., reverse=True)` has.
    .sort((a, b) =>
      b.estimatedWaste > a.estimatedWaste
        ? 1
        : b.estimatedWaste < a.estimatedWaste
          ? -1
          : 0,
    )
    .slice(0, LEADERBOARD_LIMIT)
    .map((score) => {
      const found = classifications.get(score.turnId)!
      return {
        turn_id: score.turnId,
        prompt: byId.get(score.turnId)?.prompt_text ?? null,
        category: found.category,
        complexity: found.complexity,
        confidence: roundHalfEven(found.confidence, 2),
        escalated: Boolean(found.escalated),
        rationale: found.rationale,
        calls: score.callCount,
        actual_cost: formatMoney(score.actualCost),
        estimated_waste: formatMoney(score.estimatedWaste),
        overshoot: formatMoney(score.overshootCost),
        bloat: formatMoney(score.bloatCost),
        excess_tokens: score.excessTokens,
        bloat_measured: score.bloatMeasured,
        tier_used: score.tierUsed,
        tier_required: score.tierRequired,
        normalized: score.normalized,
        band: score.band,
        zero_value: score.zeroValue,
        under_provisioned: score.underProvisioned,
        recommendation: score.recommendation,
      }
    })

const byTokenCategory = (
  calls: Call[],
  total: Money,
  table: PriceTable,
): TokenCategoryRow[] => {
  const costs = new Map<TokenCategory, Money>()
  const tokens = new Map<TokenCategory, number>()

  for (const call of calls) {
    const breakdown = table.costBreakdown(call)
    for (const category of TOKEN_CATEGORIES) {
      costs.set(category, (costs.get(category) ?? ZERO) + breakdown[category])
      tokens.set(category, (tokens.get(category) ?? 0) + call[category])
    }
  }

  return CATEGORY_ORDER.filter(
    (category) => (tokens.get(category) ?? 0) || (costs.get(category) ?? ZERO),
  ).map((category) => {
    const cost = costs.get(category) ?? ZERO
    return {
      category,
      label: CATEGORY_LABELS[category],
      cost: formatMoney(cost),
      tokens: tokens.get(category) ?? 0,
      share: share(cost, total),
    }
  })
}

const byModel = (calls: Call[], total: Money, table: PriceTable): ModelRow[] => {
  const costs = new Map<string, Money>()
  const counts = new Map<string, number>()

  for (const call of calls) {
    costs.set(call.model, (costs.get(call.model) ?? ZERO) + table.costOf(call))
    counts.set(call.model, (counts.get(call.model) ?? 0) + 1)
  }

  const rows = [...costs].map(([model, cost]) => ({ model, cost }))
  return byCostDescending(rows).map(({ model, cost }) => ({
    model,
    tier: table.tierOf(model),
    cost: formatMoney(cost),
    calls: counts.get(model) ?? 0,
    share: share(cost, total),
  }))
}

const callsPerTurn = (turns: Turn[]): { calls: number; turns: number }[] => {
  const counts = new Map<number, number>()
  for (const turn of turns) {
    counts.set(turn.calls.length, (counts.get(turn.calls.length) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([calls, turnCount]) => ({ calls, turns: turnCount }))
}
