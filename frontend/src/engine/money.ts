/**
 * Exact money arithmetic for the browser engine.
 *
 * The Python side uses `Decimal` throughout and puts decimal *strings* on the
 * wire precisely so exact values survive. JavaScript has no decimal type, and
 * `number` is not an option here: at float precision the per-category costs
 * stop summing to their total, which is a bug this project has already been
 * bitten by once.
 *
 * So money is a `bigint` count of pico-dollars (1e-12 USD). Every operation the
 * cost engine needs — scale by a token count, sum, compare — is exact integer
 * arithmetic. The scale is far finer than any figure ever displayed; it exists
 * to make intermediate sums exact, not because anyone cares about 1e-12 USD.
 *
 * Why 1e-12 specifically: a cost is `tokens x rate / 1_000_000`, so the scale
 * has to absorb six digits of division on top of whatever precision the rate
 * itself carries. Twelve leaves rates up to six decimal places exact, against a
 * table whose most precise entry today is three (`gpt-4o-mini` cache read, at
 * 0.075). `perTokenRate` rejects anything finer rather than truncating it.
 */

/** Pico-dollars. One USD is `ONE`. */
export type Money = bigint

export const SCALE = 12
const ONE = 10n ** BigInt(SCALE)
const PER_MILLION = 1_000_000n

export const ZERO: Money = 0n

/** Raised when a rate is more precise than the fixed scale can represent. */
export class PrecisionError extends Error {}

/**
 * Parse an exact decimal string into pico-dollars.
 *
 * Deliberately strict: this reads the rate table and any money that arrives
 * from the Python side, and a silently mangled rate would understate spend
 * without a visible symptom.
 */
export const parseMoney = (value: string | number): Money => {
  const text = String(value).trim()
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) {
    throw new PrecisionError(`not an exact decimal value: ${text}`)
  }

  const [, sign, whole, fraction = ''] = match
  if (fraction.length > SCALE) {
    throw new PrecisionError(
      `${text} needs ${fraction.length} decimal places; the money scale holds ${SCALE}`,
    )
  }

  const digits = whole + fraction.padEnd(SCALE, '0')
  const magnitude = BigInt(digits)
  return sign === '-' ? -magnitude : magnitude
}

/**
 * Render as a plain decimal string, trailing zeros trimmed.
 *
 * Never scientific notation — the Python side avoids it for the same reason
 * (`format(value, "f")` rather than `str()`), because a cost of `3E-6` in a
 * JSON payload is a parsing hazard for every consumer downstream.
 *
 * Note this is *canonical* rather than byte-identical to the Python output:
 * `Decimal` carries an exponent, so summing there yields "39.995350" where the
 * same value here renders "39.99535". The numbers are equal; only the trailing
 * zeros differ. Compare engines numerically, not as strings.
 */
export const formatMoney = (value: Money): string => {
  const negative = value < ZERO
  const magnitude = negative ? -value : value
  const digits = magnitude.toString().padStart(SCALE + 1, '0')

  const whole = digits.slice(0, -SCALE)
  const fraction = digits.slice(-SCALE).replace(/0+$/, '')

  const text = fraction ? `${whole}.${fraction}` : whole
  return negative ? `-${text}` : text
}

/** Lossy by construction — for display and ratios only, never stored back. */
export const toNumber = (value: Money): number => Number(value) / Number(ONE)

export const sum = (values: Iterable<Money>): Money => {
  let total = ZERO
  for (const value of values) total += value
  return total
}

/**
 * Collapse a per-million-token rate into an exact per-token price.
 *
 * Doing the division once, here, is what makes `costOf` exact by construction:
 * a token count multiplied by this can never produce a remainder. A rate too
 * precise to divide evenly is rejected loudly rather than rounded, since a
 * quietly truncated rate is exactly the kind of error that shows up only as a
 * total that no longer adds up.
 */
export const perTokenRate = (ratePerMillion: Money): Money => {
  if (ratePerMillion % PER_MILLION !== 0n) {
    throw new PrecisionError(
      `rate ${formatMoney(ratePerMillion)} per million tokens is finer than ` +
        `${SCALE - 6} decimal places and cannot be priced exactly`,
    )
  }
  return ratePerMillion / PER_MILLION
}

/** Cost of `tokens` at an already-collapsed per-token rate. */
export const cost = (tokens: number, rate: Money): Money =>
  tokens ? BigInt(tokens) * rate : ZERO
