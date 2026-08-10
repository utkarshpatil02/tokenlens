/**
 * Cross-implementation guard for scoring and the waste payload.
 *
 * `score.test.ts` pins the scorer one turn at a time against ported unit tests.
 * This pins it against a whole corpus, which is where the coupling lives: the
 * bloat reference is a median over the turns being scored, so every turn's
 * figure depends on every other turn. A port that gets the median, the
 * sample-count gating, or the pair-to-complexity fallback subtly wrong still
 * produces a completely plausible payload.
 *
 * Money is compared numerically for the reason set out in `golden.test.ts`:
 * `Decimal` carries an exponent into its string form that this engine does not
 * reproduce, and holding the port to Python's exponent bookkeeping would be
 * testing the wrong thing.
 */

import { describe, expect, it } from 'vitest'

import golden from './__fixtures__/scoring-golden.json'
import { buildAnalysis, scoreTurns } from './analysis'
import { BloatBaseline } from './baseline'
import type { Category, Classification, Complexity } from './classification'
import { parseMoney } from './money'
import { makeCall } from './models'
import type { Profile, Turn } from './models'
import { callsBaselineFrom } from './score'
import type { WasteScore } from './score'

interface SerializedTurn {
  turn_id: string
  profile: string
  timestamp: string | null
  prompt_text: string | null
  session_id: string | null
  calls: {
    model: string
    timestamp: string | null
    input_tokens: number
    output_tokens: number
    cache_read: number
    cache_write_5m: number
    cache_write_1h: number
  }[]
}

const revive = (data: SerializedTurn): Turn => ({
  turn_id: data.turn_id,
  profile: data.profile as Profile,
  timestamp: data.timestamp ? new Date(data.timestamp) : null,
  prompt_text: data.prompt_text,
  session_id: data.session_id,
  calls: data.calls.map((call) =>
    makeCall({ ...call, timestamp: call.timestamp ? new Date(call.timestamp) : null }),
  ),
})

/**
 * The fixture's classifications, keyed by turn id.
 *
 * Routed through `unknown` because TypeScript infers a literal object type per
 * case from the JSON import, and those two shapes do not overlap with each other
 * or with `Record<string, Classification>`.
 */
const reviveClassifications = (data: unknown): Map<string, Classification> =>
  new Map(Object.entries(data as Record<string, Classification>))

/** The scorer's own shape, flattened to the fixture's snake_case names. */
const flatten = (score: WasteScore) => ({
  turn_id: score.turnId,
  actual_cost: score.actualCost,
  overshoot_cost: score.overshootCost,
  bloat_cost: score.bloatCost,
  estimated_waste: score.estimatedWaste,
  tier_used: score.tierUsed,
  tier_required: score.tierRequired,
  zero_value: score.zeroValue,
  under_provisioned: score.underProvisioned,
  bloat_measured: score.bloatMeasured,
  excess_tokens: score.excessTokens,
  bloat_metric: score.bloatMetric,
  call_count: score.callCount,
  calls_baseline: score.callsBaseline,
  normalized: score.normalized,
  band: score.band,
  turn_efficiency: score.turnEfficiency,
  recommendation: score.recommendation,
})

const MONEY_FIELDS = [
  'actual_cost',
  'overshoot_cost',
  'bloat_cost',
  'estimated_waste',
] as const

describe.each(golden.cases.map((c) => [c.name, c] as const))(
  'golden: %s',
  (_name, data) => {
    const turns = (data.turns as SerializedTurn[]).map(revive)
    const classifications = reviveClassifications(data.classifications)
    const { scores, baseline } = scoreTurns(turns, classifications)
    const expected = data.payload.waste!

    describe('baseline', () => {
      it('selects the same bloat metric', () => {
        expect(baseline.metric).toBe(data.baseline.metric)
      })

      it('computes the same medians per cell', () => {
        for (const [key, value] of Object.entries(data.baseline.by_pair)) {
          const [category, complexity] = key.split('|')
          expect(
            baseline.medianFor(category as Category, complexity as Complexity),
            key,
          ).toBe(value)
        }
      })

      it('counts the same samples per cell', () => {
        for (const [key, count] of Object.entries(data.baseline.sample_counts)) {
          const [category, complexity] = key.split('|')
          expect(
            baseline.samplesFor(category as Category, complexity as Complexity),
            key,
          ).toBe(count)
        }
      })

      it('withholds every cell when the corpus is too thin', () => {
        // Only meaningful for the thin case, and vacuously true for the other —
        // which is exactly what `isEmpty` should report in each.
        const anyMedians = Object.keys(data.baseline.by_complexity).length > 0
        expect(baseline.isEmpty).toBe(!anyMedians)
      })

      it('computes the same calls-per-turn baseline', () => {
        const built = callsBaselineFrom(turns, classifications)
        expect(Object.fromEntries(built)).toEqual(data.calls_baseline)
      })
    })

    describe('scores', () => {
      const expectedScores = data.scores as Record<string, unknown>[]

      it('scores the same turns in the same order', () => {
        expect(scores.map((score) => score.turnId)).toEqual(
          expectedScores.map((score) => score.turn_id),
        )
      })

      it('agrees on every field of every score', () => {
        scores.forEach((score, index) => {
          const want = expectedScores[index]
          const got = flatten(score) as Record<string, unknown>
          for (const [field, value] of Object.entries(got)) {
            const label = `${score.turnId}.${field}`
            if ((MONEY_FIELDS as readonly string[]).includes(field)) {
              expect(value, label).toBe(parseMoney(want[field] as string))
            } else {
              expect(value, label).toEqual(want[field])
            }
          }
        })
      })

      it('never reports waste above what was spent', () => {
        for (const score of scores) {
          expect(score.estimatedWaste, score.turnId).toBeLessThanOrEqual(score.actualCost)
        }
      })
    })

    describe('waste payload', () => {
      const waste = buildAnalysis(turns, { classifications, scores }).waste!

      it('agrees on the headline figures', () => {
        expect(parseMoney(waste.total_waste)).toBe(parseMoney(expected.total_waste))
        expect(parseMoney(waste.scored_cost)).toBe(parseMoney(expected.scored_cost))
        expect(waste.waste_share).toBe(expected.waste_share)
        expect(waste.scored_turns).toBe(expected.scored_turns)
        expect(waste.unmeasured_bloat_turns).toBe(expected.unmeasured_bloat_turns)
        expect(waste.source).toEqual(expected.source)
      })

      it('agrees on the components', () => {
        expect(parseMoney(waste.components.overshoot)).toBe(
          parseMoney(expected.components.overshoot),
        )
        expect(parseMoney(waste.components.bloat)).toBe(
          parseMoney(expected.components.bloat),
        )
        expect(parseMoney(waste.components.zero_value_cost)).toBe(
          parseMoney(expected.components.zero_value_cost),
        )
      })

      it('agrees on the bands, empty ones included', () => {
        expect(waste.bands.map((row) => row.band)).toEqual(
          expected.bands.map((row) => row.band),
        )
        waste.bands.forEach((row, index) => {
          expect(row.turns, row.band).toBe(expected.bands[index].turns)
          expect(parseMoney(row.cost), row.band).toBe(
            parseMoney(expected.bands[index].cost),
          )
        })
      })

      it('agrees on the heatmap, cells and order', () => {
        expect(waste.complexity_by_tier).toHaveLength(expected.complexity_by_tier.length)
        waste.complexity_by_tier.forEach((cell, index) => {
          const want = expected.complexity_by_tier[index]
          const label = `${cell.complexity}@${cell.tier_used}`
          expect(cell.complexity, label).toBe(want.complexity)
          expect(cell.required_tier, label).toBe(want.required_tier)
          expect(cell.tier_used, label).toBe(want.tier_used)
          expect(cell.turns, label).toBe(want.turns)
          expect(parseMoney(cell.cost), label).toBe(parseMoney(want.cost))
          expect(parseMoney(cell.waste), label).toBe(parseMoney(want.waste))
        })
      })

      it('agrees on the category distribution and its order', () => {
        expect(waste.category_distribution.map((row) => row.category)).toEqual(
          expected.category_distribution.map((row) => row.category),
        )
        waste.category_distribution.forEach((row, index) => {
          expect(row.turns, row.category).toBe(
            expected.category_distribution[index].turns,
          )
          expect(parseMoney(row.cost), row.category).toBe(
            parseMoney(expected.category_distribution[index].cost),
          )
        })
      })

      it('agrees on the leaderboard, ranking included', () => {
        expect(waste.leaderboard.map((row) => row.turn_id)).toEqual(
          expected.leaderboard.map((row) => row.turn_id),
        )
        waste.leaderboard.forEach((row, index) => {
          const want = expected.leaderboard[index]
          for (const [field, value] of Object.entries(row)) {
            const label = `${row.turn_id}.${field}`
            if (['actual_cost', 'estimated_waste', 'overshoot', 'bloat'].includes(field)) {
              // Both sides are decimal strings; compare by value, since a
              // trailing zero is Python's Decimal exponent, not a different sum.
              expect(parseMoney(value as string), label).toBe(
                parseMoney(want[field as keyof typeof want] as string),
              )
            } else {
              expect(value, label).toEqual(want[field as keyof typeof want])
            }
          }
        })
      })

      it('agrees on the flags', () => {
        expect(waste.flags).toEqual(expected.flags)
      })
    })
  },
)

describe('waste section presence', () => {
  it('is null when nothing has been scored', () => {
    const turns = (golden.cases[0].turns as SerializedTurn[]).map(revive)
    expect(buildAnalysis(turns).waste).toBeNull()
  })

  it('counts classified turns in the overview', () => {
    const data = golden.cases[0]
    const turns = (data.turns as SerializedTurn[]).map(revive)
    const classifications = reviveClassifications(data.classifications)
    const built = buildAnalysis(turns, { classifications })
    expect(built.overview.classified_turns).toBe(classifications.size)
    // One turn in the corpus is deliberately unlabelled: it is real spend that
    // must appear in the totals and in no waste figure.
    expect(built.overview.turns).toBeGreaterThan(classifications.size)
  })
})

describe('baseline is derived from the corpus, not assumed', () => {
  it('changes the bloat figure when the corpus changes', () => {
    // Guards the guard: if the median were a constant, these would agree.
    const turns = (golden.cases[0].turns as SerializedTurn[]).map(revive)
    const classifications = reviveClassifications(golden.cases[0].classifications)
    const full = scoreTurns(turns, classifications)
    const half = scoreTurns(turns.slice(0, 6), classifications)

    const target = (result: { scores: WasteScore[] }) =>
      result.scores.find((score) => score.turnId === 'complex5')!
    expect(target(half).bloatCost).not.toBe(target(full).bloatCost)
  })

  it('is not the empty baseline in the full corpus', () => {
    const turns = (golden.cases[0].turns as SerializedTurn[]).map(revive)
    const classifications = reviveClassifications(golden.cases[0].classifications)
    expect(BloatBaseline.fromTurns(turns, classifications).isEmpty).toBe(false)
  })
})
