/**
 * Bloat baselines — the browser port of `tokenlens/scoring/baseline.py`.
 *
 * Bloat is "more tokens than this kind of task warrants", which requires knowing
 * what comparable tasks cost. That reference is computed from the corpus being
 * scored rather than invented, so the claim is always "large relative to your
 * own comparable work" and never a number pulled from nowhere.
 *
 * Which token category counts as bloat depends on the source profile. For
 * single-shot logs it is the prompt itself: an oversized `input_tokens`. For
 * agentic logs, `input_tokens` is ~0% of spend and the real waste is context
 * dragged through the cache on every call of the loop, so `cache_read` is the
 * measure. Using the single-shot definition on agentic data would report zero
 * bloat for every record no matter how bloated.
 *
 * A cell with too few samples yields no baseline at all. A median over two turns
 * is not a distribution, and a bloat figure derived from one would be noise
 * presented as a finding.
 */

import type { Category, Classification, Complexity } from './classification'
import { turnTokens } from './models'
import type { Call, Profile, Turn } from './models'

/** The token category that carries bloat, per profile. */
export const BLOAT_METRIC: Record<Profile, keyof Call & string> = {
  simple: 'input_tokens',
  agentic: 'cache_read',
}

/** Below this many comparable turns, no bloat baseline is claimed. */
export const DEFAULT_MIN_SAMPLES = 5

/** Composite map key, since a tuple cannot key a JavaScript Map by value. */
const pairKey = (category: Category, complexity: Complexity): string =>
  `${category}|${complexity}`

/**
 * Median, matching Python's `statistics.median`: the middle value for an odd
 * count, the mean of the two middle values for an even one.
 */
export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Median bloat-metric tokens for comparable work. */
export class BloatBaseline {
  readonly minSamples: number
  readonly metric: keyof Call & string
  private readonly byPair: Map<string, number>
  private readonly byComplexity: Map<Complexity, number>
  private readonly sampleCounts: Map<string, number>

  constructor(options: {
    minSamples?: number
    metric?: keyof Call & string
    byPair?: Map<string, number>
    byComplexity?: Map<Complexity, number>
    sampleCounts?: Map<string, number>
  } = {}) {
    this.minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES
    this.metric = options.metric ?? BLOAT_METRIC.agentic
    this.byPair = options.byPair ?? new Map()
    this.byComplexity = options.byComplexity ?? new Map()
    this.sampleCounts = options.sampleCounts ?? new Map()
  }

  /**
   * Build a baseline from classified turns.
   *
   * Turns of mixed profile are not pooled — the metric differs between them, so
   * a shared median would be meaningless. The dominant profile wins.
   */
  static fromTurns(
    turns: Iterable<Turn>,
    classifications: Map<string, Classification>,
    minSamples: number = DEFAULT_MIN_SAMPLES,
  ): BloatBaseline {
    const classified = [...turns].filter((turn) => classifications.has(turn.turn_id))
    if (!classified.length) return new BloatBaseline({ minSamples })

    const profile = dominantProfile(classified)
    const metric = BLOAT_METRIC[profile]

    const pairs = new Map<string, number[]>()
    const complexities = new Map<Complexity, number[]>()

    for (const turn of classified) {
      if (turn.profile !== profile) continue
      const found = classifications.get(turn.turn_id)!
      const value = turnTokens(turn, metric)

      const key = pairKey(found.category, found.complexity)
      if (!pairs.has(key)) pairs.set(key, [])
      pairs.get(key)!.push(value)

      if (!complexities.has(found.complexity)) complexities.set(found.complexity, [])
      complexities.get(found.complexity)!.push(value)
    }

    const enough = <K>(source: Map<K, number[]>): Map<K, number> => {
      const out = new Map<K, number>()
      for (const [key, values] of source) {
        if (values.length >= minSamples) out.set(key, median(values))
      }
      return out
    }

    return new BloatBaseline({
      minSamples,
      metric,
      byPair: enough(pairs),
      byComplexity: enough(complexities),
      sampleCounts: new Map([...pairs].map(([key, values]) => [key, values.length])),
    })
  }

  /**
   * Baseline for this kind of work, or null if the sample is too thin.
   *
   * Falls back from (category, complexity) to complexity alone, since difficulty
   * is the axis that drives token usage and a coarser reference beats no
   * reference.
   */
  medianFor(category: Category, complexity: Complexity): number | null {
    const pair = this.byPair.get(pairKey(category, complexity))
    if (pair !== undefined) return pair
    return this.byComplexity.get(complexity) ?? null
  }

  samplesFor(category: Category, complexity: Complexity): number {
    return this.sampleCounts.get(pairKey(category, complexity)) ?? 0
  }

  get isEmpty(): boolean {
    return this.byPair.size === 0 && this.byComplexity.size === 0
  }
}

const dominantProfile = (turns: Turn[]): Profile => {
  const agentic = turns.filter((turn) => turn.profile === 'agentic').length
  return agentic * 2 >= turns.length ? 'agentic' : 'simple'
}
