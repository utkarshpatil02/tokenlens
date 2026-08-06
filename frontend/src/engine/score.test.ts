/**
 * Waste Score tests, ported from `backend/tests/test_scoring.py`.
 *
 * "v1 failure modes" is the important block: it pins the two defects that made
 * the original multiplicative formula unable to measure what it existed to
 * measure. Both are cheap to reintroduce during a refactor and silent when
 * reintroduced — which is exactly why they are ported rather than assumed.
 */

import { describe, expect, it } from 'vitest'

import { BloatBaseline } from './baseline'
import type { Category, Classification, Complexity } from './classification'
import { ZERO, parseMoney } from './money'
import { makeCall } from './models'
import type { Call, Profile, Turn } from './models'
import { defaultTable } from './pricing'
import { Scorer, bandFor, callsBaselineFrom } from './score'

const WHEN = new Date('2026-07-20T00:00:00Z')

const HAIKU = 'claude-haiku-4-5' // tier 1
const SONNET = 'claude-sonnet-5' // tier 2
const OPUS = 'claude-opus-5' // tier 3

const call = (
  fields: { model?: string; cache_read?: number; output_tokens?: number } & Partial<Call> = {},
): Call =>
  makeCall({
    model: OPUS,
    timestamp: WHEN,
    cache_read: 0,
    output_tokens: 1_000,
    ...fields,
  })

const turn = (fields: Partial<Turn> = {}): Turn => ({
  turn_id: 't1',
  profile: 'agentic',
  timestamp: WHEN,
  calls: [call()],
  prompt_text: 'do a thing',
  session_id: null,
  ...fields,
})

const classification = (fields: Partial<Classification> = {}): Classification => ({
  category: 'coding',
  complexity: 'trivial',
  confidence: 0.9,
  rationale: 'r',
  model: HAIKU,
  ...fields,
})

/** A baseline asserting one known median, bypassing sample-count gating. */
const baselineWith = (
  medianTokens: number,
  category: Category = 'coding',
  complexity: Complexity = 'trivial',
): BloatBaseline =>
  new BloatBaseline({
    minSamples: 1,
    byPair: new Map([[`${category}|${complexity}`, medianTokens]]),
    byComplexity: new Map([[complexity, medianTokens]]),
    metric: 'cache_read',
  })

describe('v1 failure modes', () => {
  it('never scores a cheaper model than required as waste', () => {
    // v1 went negative here, implying a saving where there is a quality risk.
    const score = new Scorer().score(
      turn({ calls: [call({ model: HAIKU })] }),
      classification({ complexity: 'complex' }), // needs tier 3
    )
    expect(score.overshootCost).toBe(ZERO)
    expect(score.estimatedWaste).toBe(ZERO)
    expect(score.normalized).toBe(0)
  })

  it('surfaces under-provisioning rather than scoring it', () => {
    const score = new Scorer().score(
      turn({ calls: [call({ model: HAIKU })] }),
      classification({ complexity: 'complex' }),
    )
    expect(score.underProvisioned).toBe(true)
    expect(score.recommendation).toContain('quality')
  })

  it('registers bloat even when the model is correct', () => {
    // v1 multiplied bloat by an overshoot of zero, hiding half the waste.
    const score = new Scorer({ baseline: baselineWith(1_000) }).score(
      turn({ calls: [call({ model: HAIKU, cache_read: 500_000 })] }),
      classification({ complexity: 'trivial' }), // tier 1 == tier used
    )
    expect(score.overshootCost).toBe(ZERO) // model choice was right
    expect(score.bloatCost).toBeGreaterThan(ZERO) // and yet there is waste
    expect(score.estimatedWaste).toBeGreaterThan(ZERO)
  })

  it('keeps every component non-negative', () => {
    const score = new Scorer({ baseline: baselineWith(10_000_000) }).score(
      turn({ calls: [call({ model: HAIKU, cache_read: 1_000 })] }),
      classification({ complexity: 'complex' }),
    )
    expect(score.overshootCost).toBeGreaterThanOrEqual(ZERO)
    expect(score.bloatCost).toBeGreaterThanOrEqual(ZERO)
    expect(score.estimatedWaste).toBeGreaterThanOrEqual(ZERO)
  })
})

describe('overshoot', () => {
  it('scores a frontier model on a trivial task as waste', () => {
    const score = new Scorer().score(
      turn({ calls: [call({ model: OPUS })] }),
      classification(),
    )
    expect(score.overshootCost).toBeGreaterThan(ZERO)
    expect(score.tierUsed).toBe(3)
    expect(score.tierRequired).toBe(1)
  })

  it('produces no overshoot for a matching tier', () => {
    const score = new Scorer().score(
      turn({ calls: [call({ model: SONNET })] }),
      classification({ complexity: 'moderate' }),
    )
    expect(score.overshootCost).toBe(ZERO)
  })

  it('measures overshoot as the gap to the reference model', () => {
    const table = defaultTable()
    const c = call({ model: OPUS, cache_read: 100_000 })
    const score = new Scorer({ table }).score(turn({ calls: [c] }), classification())
    expect(score.overshootCost).toBe(table.costOf(c) - table.costAtTier(c, 1))
  })

  it('charges more for a bigger tier gap', () => {
    const scorer = new Scorer()
    const fromTier2 = scorer.score(
      turn({ calls: [call({ model: SONNET })] }),
      classification({ complexity: 'trivial' }),
    )
    const fromTier3 = scorer.score(
      turn({ calls: [call({ model: OPUS })] }),
      classification({ complexity: 'trivial' }),
    )
    expect(fromTier3.overshootCost).toBeGreaterThan(fromTier2.overshootCost)
  })

  it('accrues overshoot per call across mixed models', () => {
    // A turn may span models; each call is judged on its own tier.
    const mixed = new Scorer().score(
      turn({ calls: [call({ model: OPUS }), call({ model: HAIKU })] }),
      classification(),
    )
    const onlyOpus = new Scorer().score(
      turn({ calls: [call({ model: OPUS })] }),
      classification(),
    )
    expect(mixed.overshootCost).toBe(onlyOpus.overshootCost)
  })

  it('includes output tokens in the counterfactual', () => {
    // Output is a large share of cost and is priced differently per model.
    const table = defaultTable()
    const c = call({ model: OPUS, output_tokens: 100_000, cache_read: 0 })
    expect(table.costAtTier(c, 1)).toBeLessThan(table.costOf(c))
  })
})

describe('bloat', () => {
  it('prices the excess over the median', () => {
    const score = new Scorer({ baseline: baselineWith(10_000) }).score(
      turn({ calls: [call({ model: HAIKU, cache_read: 60_000 })] }),
      classification(),
    )
    expect(score.excessTokens).toBe(50_000)
    expect(score.bloatCost).toBeGreaterThan(ZERO)
  })

  it('does not treat usage at the median as bloat', () => {
    const score = new Scorer({ baseline: baselineWith(10_000) }).score(
      turn({ calls: [call({ model: HAIKU, cache_read: 10_000 })] }),
      classification(),
    )
    expect(score.bloatCost).toBe(ZERO)
    expect(score.excessTokens).toBe(0)
  })

  it('does not treat below-median usage as bloat', () => {
    const score = new Scorer({ baseline: baselineWith(10_000) }).score(
      turn({ calls: [call({ model: HAIKU, cache_read: 500 })] }),
      classification(),
    )
    expect(score.bloatCost).toBe(ZERO)
  })

  it('claims no bloat from a thin sample', () => {
    // A median over too few turns is noise; report nothing instead.
    const score = new Scorer({ baseline: new BloatBaseline() }).score(
      turn({ calls: [call({ cache_read: 999_999 })] }),
      classification(),
    )
    expect(score.bloatMeasured).toBe(false)
    expect(score.bloatCost).toBe(ZERO)
  })

  it('prices the excess at the required tier, not the tier used', () => {
    // Otherwise overshoot and bloat bill the same excess tokens twice. Both
    // turns need tier 1, so the excess costs the same in each; the fact that one
    // ran on Opus is charged by overshoot, not again by bloat.
    const scorer = new Scorer({ baseline: baselineWith(1_000) })
    const onOpus = scorer.score(
      turn({ calls: [call({ model: OPUS, cache_read: 100_000 })] }),
      classification(),
    )
    const onHaiku = scorer.score(
      turn({ calls: [call({ model: HAIKU, cache_read: 100_000 })] }),
      classification(),
    )
    expect(onOpus.bloatCost).toBe(onHaiku.bloatCost)
  })

  it('prices the same excess higher for a higher required tier', () => {
    const scorer = new Scorer({
      baseline: new BloatBaseline({
        minSamples: 1,
        byComplexity: new Map([
          ['trivial', 1_000],
          ['complex', 1_000],
        ]),
        metric: 'cache_read',
      }),
    })
    const cheapTier = scorer.score(
      turn({ calls: [call({ model: OPUS, cache_read: 100_000 })] }),
      classification({ complexity: 'trivial' }),
    )
    const frontierTier = scorer.score(
      turn({ calls: [call({ model: OPUS, cache_read: 100_000 })] }),
      classification({ complexity: 'complex' }),
    )
    expect(frontierTier.bloatCost).toBeGreaterThan(cheapTier.bloatCost)
  })

  it('uses cache_read on agentic data, not input', () => {
    // On agentic data input_tokens is ~0% of spend; using it measures nothing.
    const score = new Scorer({ baseline: baselineWith(1_000) }).score(
      turn({ calls: [call({ model: HAIKU, input_tokens: 2, cache_read: 400_000 })] }),
      classification(),
    )
    expect(score.bloatMetric).toBe('cache_read')
    expect(score.bloatCost).toBeGreaterThan(ZERO)
  })

  it('uses input_tokens on a simple profile', () => {
    const baseline = new BloatBaseline({
      minSamples: 1,
      byPair: new Map([['coding|trivial', 400]]),
      metric: 'input_tokens',
    })
    const score = new Scorer({ baseline }).score(
      turn({
        profile: 'simple' as Profile,
        calls: [call({ model: OPUS, input_tokens: 3_200, cache_read: 0 })],
      }),
      classification(),
    )
    expect(score.bloatMetric).toBe('input_tokens')
    expect(score.excessTokens).toBe(2_800)
  })
})

describe('zero value', () => {
  it('forfeits the whole cost for busywork', () => {
    // No cheaper tier is the remedy — the call should not have happened.
    const score = new Scorer().score(
      turn({ calls: [call({ model: HAIKU })] }),
      classification({ category: 'busywork' }),
    )
    expect(score.zeroValue).toBe(true)
    expect(score.estimatedWaste).toBe(score.actualCost)
    expect(score.normalized).toBe(100)
  })

  it('still caps busywork on a frontier model at cost', () => {
    const score = new Scorer({ baseline: baselineWith(100) }).score(
      turn({ calls: [call({ model: OPUS, cache_read: 500_000 })] }),
      classification({ category: 'busywork' }),
    )
    expect(score.estimatedWaste).toBe(score.actualCost)
  })

  it('does not flag non-busywork', () => {
    const score = new Scorer().score(turn(), classification({ category: 'coding' }))
    expect(score.zeroValue).toBe(false)
  })
})

describe('component additivity', () => {
  // Overshoot and bloat must be disjoint, or waste is overstated. Together they
  // should equal `actual - ideal`, where ideal is the required tier at the
  // median volume.

  it('sums the components to actual minus ideal', () => {
    const table = defaultTable()
    const medianTokens = 400
    const c = call({ model: OPUS, input_tokens: 3_200, output_tokens: 800, cache_read: 0 })
    const baseline = new BloatBaseline({
      minSamples: 1,
      byPair: new Map([['coding|trivial', medianTokens]]),
      metric: 'input_tokens',
    })
    const score = new Scorer({ baseline, table }).score(
      turn({ profile: 'simple' as Profile, calls: [c] }),
      classification(),
    )

    const ideal = table.costOf(
      makeCall({
        model: table.referenceModel(1),
        timestamp: WHEN,
        input_tokens: medianTokens,
        output_tokens: 800,
      }),
    )
    expect(score.overshootCost + score.bloatCost).toBe(score.actualCost - ideal)
  })

  it("matches the PRD worked example's published figures", () => {
    // 3,200-token prompt to Opus for a trivial reformat; median is 400.
    const baseline = new BloatBaseline({
      minSamples: 1,
      byPair: new Map([['coding|trivial', 400]]),
      metric: 'input_tokens',
    })
    const score = new Scorer({ baseline }).score(
      turn({
        profile: 'simple' as Profile,
        calls: [
          call({ model: OPUS, input_tokens: 3_200, output_tokens: 800, cache_read: 0 }),
        ],
      }),
      classification(),
    )
    expect(score.excessTokens).toBe(2_800)
    expect(score.tierUsed).toBe(3)
    expect(score.tierRequired).toBe(1)
    expect(score.normalized).toBe(88)
    expect(score.band).toBe('critical')
  })

  it('never lets overshoot alone exceed cost', () => {
    const score = new Scorer().score(
      turn({ calls: [call({ model: OPUS, cache_read: 900_000 })] }),
      classification(),
    )
    expect(score.overshootCost).toBeLessThan(score.actualCost)
  })
})

describe('invariants', () => {
  const extreme = () =>
    new Scorer({ baseline: baselineWith(1) }).score(
      turn({ calls: [call({ model: OPUS, cache_read: 5_000_000 })] }),
      classification(),
    )

  it('never lets waste exceed spend', () => {
    const score = extreme()
    expect(score.estimatedWaste).toBeLessThanOrEqual(score.actualCost)
  })

  it('bounds normalized to 0..100', () => {
    const score = extreme()
    expect(score.normalized).toBeGreaterThanOrEqual(0)
    expect(score.normalized).toBeLessThanOrEqual(100)
  })

  it('does not divide by zero on a zero-cost turn', () => {
    const score = new Scorer().score(
      turn({ calls: [call({ model: HAIKU, output_tokens: 0 })] }),
      classification(),
    )
    expect(score.normalized).toBe(0)
  })

  it('handles a turn with no calls', () => {
    const score = new Scorer().score(turn({ calls: [] }), classification())
    expect(score.actualCost).toBe(ZERO)
    expect(score.estimatedWaste).toBe(ZERO)
  })

  it('keeps components exact rather than float', () => {
    const score = new Scorer({ baseline: baselineWith(10) }).score(
      turn({ calls: [call({ cache_read: 1_000 })] }),
      classification(),
    )
    expect(typeof score.overshootCost).toBe('bigint')
    expect(typeof score.bloatCost).toBe('bigint')
    expect(typeof score.estimatedWaste).toBe('bigint')
  })
})

describe('bands', () => {
  it.each([
    [0, 'efficient'],
    [20, 'efficient'],
    [21, 'moderate'],
    [50, 'moderate'],
    [51, 'high'],
    [80, 'high'],
    [81, 'critical'],
    [100, 'critical'],
  ] as const)('bands %i as %s', (value, expected) => {
    expect(bandFor(value)).toBe(expected)
  })

  it('lands a clean turn in efficient', () => {
    const score = new Scorer().score(
      turn({ calls: [call({ model: SONNET })] }),
      classification({ complexity: 'moderate' }),
    )
    expect(score.band).toBe('efficient')
  })
})

describe('recommendation', () => {
  it('recommends the required tier for overshoot', () => {
    const score = new Scorer().score(
      turn({ calls: [call({ model: OPUS })] }),
      classification(),
    )
    expect(score.recommendation).toContain('tier 1')
  })

  it('recommends trimming for bloat', () => {
    const score = new Scorer({ baseline: baselineWith(1_000) }).score(
      turn({ calls: [call({ model: HAIKU, cache_read: 90_000 })] }),
      classification(),
    )
    expect(score.recommendation).toContain('trim')
  })

  it('formats the excess with thousands separators', () => {
    // Python writes `{:,}` regardless of locale; the runtime must not decide.
    const score = new Scorer({ baseline: baselineWith(1_000) }).score(
      turn({ calls: [call({ model: HAIKU, cache_read: 90_000 })] }),
      classification(),
    )
    expect(score.recommendation).toContain('trim 89,000 excess cache_read tokens')
  })

  it('recommends not calling at all for busywork', () => {
    const score = new Scorer().score(turn(), classification({ category: 'busywork' }))
    expect(score.recommendation).toContain('did not warrant')
  })

  it('says so for a clean turn', () => {
    const score = new Scorer().score(
      turn({ calls: [call({ model: SONNET })] }),
      classification({ complexity: 'moderate' }),
    )
    expect(score.recommendation).toBe('No waste detected')
  })
})

describe('baseline construction', () => {
  const corpus = (n = 6) => {
    const turns = Array.from({ length: n }, (_, i) =>
      turn({
        turn_id: `t${i}`,
        calls: [call({ model: HAIKU, cache_read: 1_000 * (i + 1) })],
      }),
    )
    const found = new Map(turns.map((t) => [t.turn_id, classification()]))
    return { turns, found }
  }

  it('computes the median from the corpus', () => {
    const { turns, found } = corpus()
    const baseline = BloatBaseline.fromTurns(turns, found, 3)
    expect(baseline.medianFor('coding', 'trivial')).toBe(3_500)
  })

  it('withholds a thin cell', () => {
    const { turns, found } = corpus(2)
    const baseline = BloatBaseline.fromTurns(turns, found, 5)
    expect(baseline.medianFor('coding', 'trivial')).toBeNull()
  })

  it('falls back from pair to complexity', () => {
    // A coarser reference beats no reference.
    const { turns, found } = corpus(6)
    const baseline = BloatBaseline.fromTurns(turns, found, 3)
    expect(baseline.medianFor('writing', 'trivial')).toBe(3_500)
  })

  it('excludes unclassified turns', () => {
    const { turns } = corpus()
    expect(BloatBaseline.fromTurns(turns, new Map()).isEmpty).toBe(true)
  })

  it('selects the cache_read metric for an agentic corpus', () => {
    const { turns, found } = corpus()
    expect(BloatBaseline.fromTurns(turns, found, 3).metric).toBe('cache_read')
  })

  it('treats an empty corpus as empty rather than an error', () => {
    expect(BloatBaseline.fromTurns([], new Map()).isEmpty).toBe(true)
  })

  it('reports sample counts per cell', () => {
    const { turns, found } = corpus(6)
    expect(BloatBaseline.fromTurns(turns, found, 3).samplesFor('coding', 'trivial')).toBe(6)
  })
})

describe('calls baseline', () => {
  it('takes the median calls per complexity', () => {
    const turns = Array.from({ length: 5 }, (_, i) =>
      turn({
        turn_id: `t${i}`,
        calls: Array.from({ length: i + 1 }, () => call()),
      }),
    )
    const found = new Map(turns.map((t) => [t.turn_id, classification()]))
    expect(callsBaselineFrom(turns, found, 3).get('trivial')).toBe(3)
  })

  it('reports the efficiency ratio', () => {
    const scorer = new Scorer({ callsBaseline: new Map([['trivial', 4]]) })
    const score = scorer.score(
      turn({ calls: Array.from({ length: 20 }, () => call()) }),
      classification(),
    )
    expect(score.turnEfficiency).toBe(5)
  })

  it('reports no efficiency without a baseline', () => {
    expect(new Scorer().score(turn(), classification()).turnEfficiency).toBeNull()
  })

  it('does not price efficiency', () => {
    // Extra calls' cost already sits in cache_read; charging twice is wrong.
    const scorer = new Scorer({ callsBaseline: new Map([['trivial', 1]]) })
    const calls = Array.from({ length: 10 }, () => call({ model: HAIKU }))
    const score = scorer.score(turn({ calls }), classification())
    expect(score.estimatedWaste).toBe(ZERO)
    expect(score.turnEfficiency).toBe(10)
  })
})

describe('scoreAll', () => {
  it('scores only classified turns', () => {
    const turns = [turn({ turn_id: 't1' }), turn({ turn_id: 't2' })]
    const scores = new Scorer().scoreAll(turns, new Map([['t1', classification()]]))
    expect(scores.map((score) => score.turnId)).toEqual(['t1'])
  })

  it('yields no scores for empty input', () => {
    expect(new Scorer().scoreAll([], new Map())).toEqual([])
  })
})

describe('money handling', () => {
  it('prices bloat exactly, not as a float', () => {
    // 89,000 excess cache_read tokens at tier 1's 0.10/M is exactly $0.0089.
    const score = new Scorer({ baseline: baselineWith(1_000) }).score(
      turn({ calls: [call({ model: HAIKU, cache_read: 90_000 })] }),
      classification(),
    )
    expect(score.bloatCost).toBe(parseMoney('0.0089'))
  })
})
