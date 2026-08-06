/**
 * Money tests.
 *
 * These have no Python counterpart — `Decimal` came with these guarantees for
 * free, and this module is the risk the port introduces. The float trap is the
 * point: `0.1 + 0.2 !== 0.3` is the whole reason the engine does not use
 * `number`, and the summation cases below are the ones that would fail if it
 * ever did.
 */

import { describe, expect, it } from 'vitest'

import {
  PrecisionError,
  SCALE,
  ZERO,
  formatMoney,
  parseMoney,
  perTokenRate,
  sum,
  toNumber,
} from './money'

describe('parsing', () => {
  it('round-trips an exact decimal string', () => {
    for (const text of ['0', '1', '5.25', '0.075', '119.4670569', '0.000000000001']) {
      expect(formatMoney(parseMoney(text))).toBe(text)
    }
  })

  it('normalizes trailing zeros away', () => {
    // The Python side carries a Decimal exponent and renders "39.995350"; the
    // same value here renders "39.99535". Equal numbers, canonical formatting.
    expect(formatMoney(parseMoney('39.995350'))).toBe('39.99535')
    expect(parseMoney('39.995350')).toBe(parseMoney('39.99535'))
  })

  it('handles negatives', () => {
    expect(formatMoney(parseMoney('-2.50'))).toBe('-2.5')
    expect(parseMoney('-2.50')).toBe(-parseMoney('2.50'))
  })

  it('accepts numbers as well as strings', () => {
    expect(parseMoney(5)).toBe(parseMoney('5'))
  })

  it('rejects a value finer than the scale rather than truncating it', () => {
    expect(() => parseMoney('0.0000000000001')).toThrow(PrecisionError)
  })

  it('rejects text that is not an exact decimal', () => {
    for (const text of ['', 'abc', '1e-6', '1.2.3', 'NaN', '0x10']) {
      expect(() => parseMoney(text)).toThrow(PrecisionError)
    }
  })

  it('never renders scientific notation', () => {
    // A cost of "3E-6" in a JSON payload is a parsing hazard downstream.
    expect(formatMoney(parseMoney('0.000003'))).toBe('0.000003')
    expect(formatMoney(ZERO)).toBe('0')
  })
})

describe('exactness', () => {
  it('sums without the float error that broke this once before', () => {
    const tenth = parseMoney('0.1')
    const fifth = parseMoney('0.2')
    expect(tenth + fifth).toBe(parseMoney('0.3'))
    // The failure this stands in for:
    expect(0.1 + 0.2).not.toBe(0.3)
  })

  it('keeps a long run of small costs summing to their total', () => {
    const cents = Array.from({ length: 1_000 }, () => parseMoney('0.000001'))
    expect(sum(cents)).toBe(parseMoney('0.001'))
  })

  it('sums an empty run to zero', () => {
    expect(sum([])).toBe(ZERO)
  })
})

describe('per-token rates', () => {
  it('divides a per-million rate exactly', () => {
    expect(perTokenRate(parseMoney('1.00'))).toBe(parseMoney('0.000001'))
    expect(perTokenRate(parseMoney('0.075'))).toBe(parseMoney('0.000000075'))
  })

  it('rejects a rate too precise to price exactly', () => {
    // Six decimal places is the limit at this scale; a seventh cannot divide by
    // a million without a remainder, and a quietly truncated rate is exactly the
    // error that shows up only as a total that no longer adds up.
    expect(() => perTokenRate(parseMoney('0.0000001'))).toThrow(PrecisionError)
  })
})

describe('display conversion', () => {
  it('converts to a number for ratios', () => {
    expect(toNumber(parseMoney('119.4670569'))).toBeCloseTo(119.4670569, 7)
  })

  it('exposes the scale it was built on', () => {
    expect(SCALE).toBe(12)
  })
})
