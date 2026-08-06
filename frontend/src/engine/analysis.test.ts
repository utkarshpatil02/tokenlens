/**
 * Analysis layer tests.
 *
 * The golden cases are the substance: the aggregation rules are small decisions
 * that are easy to port almost-right, and "almost" here means the CLI and the
 * web app quietly disagree about a number on the dashboard.
 *
 * The rounding block is separate because it is the one place the two languages
 * genuinely differ rather than merely risk differing — Python rounds halves to
 * even, JavaScript rounds them away from zero.
 */

import { describe, expect, it } from 'vitest'

import golden from './__fixtures__/analysis-golden.json'
import { buildAnalysis, roundHalfEven, withPriceableCalls } from './analysis'
import { parseMoney } from './money'
import { makeCall } from './models'
import type { Profile, Turn } from './models'

interface SerializedCall {
  model: string
  timestamp: string | null
  input_tokens: number
  output_tokens: number
  cache_read: number
  cache_write_5m: number
  cache_write_1h: number
}

interface SerializedTurn {
  turn_id: string
  profile: string
  timestamp: string | null
  prompt_text: string | null
  session_id: string | null
  calls: SerializedCall[]
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

const turn = (
  id: string,
  calls: ReturnType<typeof makeCall>[],
  extra: Partial<Turn> = {},
): Turn => ({
  turn_id: id,
  profile: 'agentic',
  timestamp: null,
  prompt_text: null,
  session_id: null,
  calls,
  ...extra,
})

type TokenCounts = Partial<Omit<SerializedCall, 'model' | 'timestamp'>>

const opus = (tokens: TokenCounts = {}) =>
  makeCall({
    model: 'claude-opus-5',
    timestamp: new Date('2026-09-01T00:00:00Z'),
    ...tokens,
  })

describe('rounding', () => {
  // Python rounds halves to even; JavaScript does not. Every case here is one
  // the CLI has already committed to.
  it.each(golden.rounding.map((c) => [c.value, c.digits, c.expected] as const))(
    'round(%s, %s) is %s',
    (value, digits, expected) => {
      expect(roundHalfEven(Number(value), digits)).toBe(Number(expected))
    },
  )

  it('differs from the naive implementation where it must', () => {
    // Guards the guard: if these agreed, emulating Python would be pointless.
    expect(roundHalfEven(0.125, 2)).toBe(0.12)
    expect(Number((0.125).toFixed(2))).toBe(0.13)
  })
})

describe.each(golden.cases.map((c) => [c.name, c] as const))(
  'golden: %s',
  (_name, data) => {
    const turns = (data.turns as SerializedTurn[]).map(revive)
    const built = buildAnalysis(turns)
    const expected = data.payload

    it('agrees on the overview', () => {
      const { total_cost, ...counts } = built.overview
      const { total_cost: expectedCost, ...expectedCounts } = expected.overview
      expect(counts).toEqual(expectedCounts)
      expect(parseMoney(total_cost)).toBe(parseMoney(expectedCost))
    })

    it('agrees on cost by token category, in order and filtering', () => {
      expect(built.cost_by_token_category.map((row) => row.category)).toEqual(
        expected.cost_by_token_category.map((row) => row.category),
      )
      built.cost_by_token_category.forEach((row, index) => {
        const want = expected.cost_by_token_category[index]
        expect(parseMoney(row.cost), row.category).toBe(parseMoney(want.cost))
        expect(row.tokens, row.category).toBe(want.tokens)
        expect(row.share, row.category).toBe(want.share)
        expect(row.label, row.category).toBe(want.label)
      })
    })

    it('agrees on cost by model, including tie order', () => {
      expect(built.cost_by_model.map((row) => row.model)).toEqual(
        expected.cost_by_model.map((row) => row.model),
      )
      built.cost_by_model.forEach((row, index) => {
        const want = expected.cost_by_model[index]
        expect(parseMoney(row.cost), row.model).toBe(parseMoney(want.cost))
        expect(row.calls, row.model).toBe(want.calls)
        expect(row.tier, row.model).toBe(want.tier)
        expect(row.share, row.model).toBe(want.share)
      })
    })

    it('agrees on turn shape', () => {
      expect(built.calls_per_turn).toEqual(expected.calls_per_turn)
    })

    it('agrees on the rate table it priced against', () => {
      expect(built.rate_table).toEqual(expected.rate_table)
    })

    it('leaves waste unmeasured rather than zero', () => {
      // Zeros would read as "no waste found"; null reads as "not measured".
      expect(built.waste).toBeNull()
      expect(expected.waste).toBeNull()
    })
  },
)

describe('payload shape', () => {
  it('stamps a generated time', () => {
    const built = buildAnalysis([turn('t', [opus({ output_tokens: 10 })])])
    expect(Number.isNaN(Date.parse(built.generated_at))).toBe(false)
  })

  it('serializes money as a string, never a number', () => {
    // A JSON number would round-trip through a float and perturb the figure.
    const built = buildAnalysis([turn('t', [opus({ output_tokens: 10 })])])
    expect(typeof built.overview.total_cost).toBe('string')
    expect(typeof built.cost_by_model[0].cost).toBe('string')
  })
})

describe('scorable turns', () => {
  it('counts a turn with prompt text', () => {
    const built = buildAnalysis([
      turn('a', [opus({ output_tokens: 1 })], { prompt_text: 'do a thing' }),
    ])
    expect(built.overview.scorable_turns).toBe(1)
  })

  it('does not count a whitespace-only or missing prompt', () => {
    const built = buildAnalysis([
      turn('a', [opus({ output_tokens: 1 })], { prompt_text: '   ' }),
      turn('b', [opus({ output_tokens: 1 })], { prompt_text: null }),
    ])
    expect(built.overview.scorable_turns).toBe(0)
    expect(built.overview.turns).toBe(2)
  })
})

describe('unpriceable models', () => {
  const mystery = makeCall({ model: 'llama-3-70b', timestamp: null, output_tokens: 100 })

  it('raises rather than pricing an unknown model at zero', () => {
    expect(() => buildAnalysis([turn('t', [mystery])])).toThrow(/llama-3-70b/)
  })

  it('drops unpriceable calls when asked, and counts them', () => {
    const result = withPriceableCalls([
      turn('t1', [opus({ output_tokens: 10 }), mystery]),
      turn('t2', [mystery]),
    ])
    expect(result.droppedCalls).toBe(2)
    expect(result.droppedModels).toEqual(['llama-3-70b'])
    // t2 had nothing priceable left, so it is gone entirely.
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0].calls).toHaveLength(1)
  })

  it('leaves a fully priceable turn untouched', () => {
    const turns = [turn('t1', [opus({ output_tokens: 10 })])]
    const result = withPriceableCalls(turns)
    expect(result.turns[0]).toBe(turns[0])
    expect(result.droppedCalls).toBe(0)
  })

  it('produces an analysis once the unpriceable calls are gone', () => {
    const { turns } = withPriceableCalls([turn('t1', [opus({ output_tokens: 10 }), mystery])])
    expect(buildAnalysis(turns).overview.calls).toBe(1)
  })
})

describe('empty input', () => {
  it('reports zeros rather than dividing by zero', () => {
    const built = buildAnalysis([])
    expect(built.overview.mean_calls_per_turn).toBe(0)
    expect(parseMoney(built.overview.total_cost)).toBe(0n)
    expect(built.cost_by_model).toEqual([])
    expect(built.calls_per_turn).toEqual([])
  })
})
