/**
 * Cost engine tests, ported from `backend/tests/test_pricing.py`.
 *
 * The port is deliberately case-for-case: these tests are the specification the
 * TypeScript engine has to satisfy, and any case dropped here is a way the two
 * implementations could silently disagree about what a figure means.
 *
 * The cache-aware cases are the ones that matter: the engine exists because
 * pricing only `input_tokens` and `output_tokens` misses ~99% of real agentic
 * spend, and because the 1-hour cache TTL costs 2x base against the 5-minute
 * tier's 1.25x.
 */

import { describe, expect, it } from 'vitest'

import { formatMoney, parseMoney, sum } from './money'
import type { Money } from './money'
import { billableInputTokens, cacheWrite, makeCall, totalTokens } from './models'
import type { Call } from './models'
import { PriceTable, TOKEN_CATEGORIES, UnknownModelError, defaultTable } from './pricing'

/** Inside the Sonnet 5 introductory window (through 2026-08-31). */
const DURING_PROMO = new Date('2026-07-26T00:00:00Z')
/** After it. */
const AFTER_PROMO = new Date('2026-09-01T00:00:00Z')

const table = (): PriceTable => defaultTable()

const call = (
  tokens: Partial<Call> = {},
  model = 'claude-opus-5',
  when: Date | null = AFTER_PROMO,
): Call => makeCall({ model, timestamp: when, ...tokens })

/** Exact scaling by a decimal factor, for comparisons the Python does with `Decimal`. */
const times = (value: Money, numerator: bigint, denominator: bigint): Money =>
  (value * numerator) / denominator

describe('cache write TTL', () => {
  // The 1h vs 5m split is the detail most cost estimators get wrong.

  it('costs more for a 1h write than a 5m write of the same tokens', () => {
    const tokens = 100_000
    const fiveMin = table().costOf(call({ cache_write_5m: tokens }))
    const oneHour = table().costOf(call({ cache_write_1h: tokens }))
    expect(oneHour).toBeGreaterThan(fiveMin)
  })

  it('prices writes at 1.25x and 2x base input', () => {
    const tokens = 1_000_000
    const base = table().costOf(call({ input_tokens: tokens }))
    expect(table().costOf(call({ cache_write_5m: tokens }))).toBe(times(base, 125n, 100n))
    expect(table().costOf(call({ cache_write_1h: tokens }))).toBe(times(base, 2n, 1n))
  })

  it('prices a cache read at a tenth of base input', () => {
    const tokens = 1_000_000
    const base = table().costOf(call({ input_tokens: tokens }))
    expect(table().costOf(call({ cache_read: tokens }))).toBe(times(base, 1n, 10n))
  })

  it('sums the TTL tiers rather than double-counting them', () => {
    const both = table().costOf(call({ cache_write_5m: 40_000, cache_write_1h: 60_000 }))
    const separate =
      table().costOf(call({ cache_write_5m: 40_000 })) +
      table().costOf(call({ cache_write_1h: 60_000 }))
    expect(both).toBe(separate)
  })
})

describe('cache awareness', () => {
  // Regression guard for the bug this engine was designed to avoid.

  /** The shape of a real agentic call: input near zero, cost carried by cache and output. */
  const agenticCall = () =>
    call({ input_tokens: 2, output_tokens: 286, cache_read: 34_488, cache_write_1h: 12_359 })

  it('does not price a cache-only call at zero', () => {
    expect(table().costOf(agenticCall())).toBeGreaterThan(parseMoney('0.10'))
  })

  it('shows uncached input is a negligible share of agentic cost', () => {
    // Documents *why* pricing input alone is not viable.
    const c = agenticCall()
    const breakdown = table().costBreakdown(c)
    const share = Number(breakdown.input_tokens) / Number(table().costOf(c))
    expect(share).toBeLessThan(0.001)
  })

  it('sums the breakdown to the total', () => {
    const c = call({
      input_tokens: 500,
      output_tokens: 1_200,
      cache_read: 80_000,
      cache_write_1h: 9_000,
    })
    expect(sum(Object.values(table().costBreakdown(c)))).toBe(table().costOf(c))
  })

  it('covers every priced category in the breakdown', () => {
    const breakdown = table().costBreakdown(call({ input_tokens: 10 }))
    expect(Object.keys(breakdown).sort()).toEqual([...TOKEN_CATEGORIES].sort())
  })
})

describe('promotional pricing', () => {
  // Sonnet 5 introductory rates run through 2026-08-31.

  it('applies the promo inside the window', () => {
    const rates = table().ratesFor('claude-sonnet-5', DURING_PROMO)
    expect(rates.promotional).toBe(true)
    expect(rates.input).toBe(parseMoney('2.00'))
  })

  it('applies list rates after the window', () => {
    const rates = table().ratesFor('claude-sonnet-5', AFTER_PROMO)
    expect(rates.promotional).toBe(false)
    expect(rates.input).toBe(parseMoney('3.00'))
  })

  it('treats the last day of the window as inclusive', () => {
    const rates = table().ratesFor(
      'claude-sonnet-5',
      new Date('2026-08-31T23:59:00Z'),
    )
    expect(rates.promotional).toBe(true)
  })

  it('list-prices the first day after the window', () => {
    const rates = table().ratesFor('claude-sonnet-5', new Date('2026-09-01T00:00:00Z'))
    expect(rates.promotional).toBe(false)
  })

  it('does not assume a discount when the date is unknown', () => {
    // Never silently apply a time-limited rate we cannot justify.
    expect(table().ratesFor('claude-sonnet-5', null).promotional).toBe(false)
  })

  it('lowers the actual call cost inside the window', () => {
    const tokens = { input_tokens: 1_000_000 }
    const during = table().costOf(call(tokens, 'claude-sonnet-5', DURING_PROMO))
    const after = table().costOf(call(tokens, 'claude-sonnet-5', AFTER_PROMO))
    expect(during).toBeLessThan(after)
  })

  it('leaves a model without a promo date-insensitive', () => {
    const tokens = { input_tokens: 1_000_000 }
    const during = table().costOf(call(tokens, 'claude-opus-5', DURING_PROMO))
    const after = table().costOf(call(tokens, 'claude-opus-5', AFTER_PROMO))
    expect(during).toBe(after)
  })
})

describe('model resolution', () => {
  it('resolves a known model to itself', () => {
    expect(table().resolve('claude-opus-5')).toBe('claude-opus-5')
  })

  it('falls back by prefix for an unlisted point version', () => {
    // A model released after the table was written should still price.
    expect(table().resolve('claude-opus-9-9')).toBe('claude-opus-5')
  })

  it('lets the longest prefix win', () => {
    expect(table().resolve('gpt-4o-mini-2099')).toBe('gpt-4o-mini')
    expect(table().resolve('gpt-4o-2099')).toBe('gpt-4o')
  })

  it('raises on an unknown model rather than pricing it at zero', () => {
    expect(() => table().costOf(call({ input_tokens: 1_000 }, 'mystery-model'))).toThrow(
      UnknownModelError,
    )
    expect(() => table().costOf(call({ input_tokens: 1_000 }, 'mystery-model'))).toThrow(
      /mystery-model/,
    )
  })

  it('orders tiers cheap to frontier', () => {
    expect(table().tierOf('claude-haiku-4-5')).toBe(1)
    expect(table().tierOf('claude-sonnet-5')).toBe(2)
    expect(table().tierOf('claude-opus-5')).toBe(3)
  })

  it('does not let promotional rates affect the tier', () => {
    expect(table().ratesFor('claude-sonnet-5', DURING_PROMO).tier).toBe(2)
  })
})

describe('counterfactual pricing', () => {
  it('reprices a call onto the reference model for a tier', () => {
    const c = call({ input_tokens: 1_000_000, output_tokens: 1_000_000 })
    const asHaiku = table().costAtTier(c, 1)
    const direct = table().costOf({ ...c, model: 'claude-haiku-4-5' })
    expect(asHaiku).toBe(direct)
  })

  it('raises for a tier with no reference model', () => {
    expect(() => table().referenceModel(9)).toThrow(UnknownModelError)
  })
})

describe('edge cases', () => {
  it('costs nothing for a zero-token call', () => {
    expect(table().costOf(call())).toBe(0n)
  })

  it('stays exact rather than becoming a float', () => {
    const cost = table().costOf(call({ input_tokens: 3 }, 'claude-haiku-4-5'))
    expect(typeof cost).toBe('bigint')
    expect(cost).toBe(parseMoney('0.000003'))
    expect(formatMoney(cost)).toBe('0.000003')
  })

  it('costs more on a frontier model than a cheap one', () => {
    const tokens = { input_tokens: 1_000_000, output_tokens: 1_000_000 }
    expect(table().costOf(call(tokens, 'claude-opus-5'))).toBeGreaterThan(
      table().costOf(call(tokens, 'claude-haiku-4-5')),
    )
  })

  it('scales linearly with tokens', () => {
    const one = table().costOf(call({ output_tokens: 1_000 }))
    const ten = table().costOf(call({ output_tokens: 10_000 }))
    expect(ten).toBe(one * 10n)
  })
})

describe('table metadata', () => {
  it('is dated and versioned', () => {
    // Any published figure must be traceable to the table that produced it.
    expect(table().version).toBeGreaterThanOrEqual(1)
    expect(Number(table().updated.slice(0, 4))).toBeGreaterThanOrEqual(2026)
    expect(table().currency).toBe('USD')
  })
})

describe('call model', () => {
  it('sums both TTLs into cache write', () => {
    expect(cacheWrite(call({ cache_write_5m: 10, cache_write_1h: 32 }))).toBe(42)
  })

  it('excludes output from billable input', () => {
    const c = call({ input_tokens: 5, output_tokens: 999, cache_read: 10, cache_write_1h: 20 })
    expect(billableInputTokens(c)).toBe(35)
  })

  it('covers every category in total tokens', () => {
    const c = call({
      input_tokens: 1,
      output_tokens: 2,
      cache_read: 4,
      cache_write_5m: 8,
      cache_write_1h: 16,
    })
    expect(totalTokens(c)).toBe(31)
  })
})
