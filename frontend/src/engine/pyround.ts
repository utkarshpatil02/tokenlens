/**
 * Python-compatible rounding.
 *
 * Lives in its own module because both the scorer and the analysis layer need
 * it, and having either import the other would make a cycle.
 */

/**
 * Round the way Python's `round()` rounds: half to even.
 *
 * This exists because the CLI's figures come out of `round(...)` and this engine
 * has to match them. JavaScript rounds halves away from zero, so a share of
 * exactly 5/32 becomes 0.1563 here and 0.1562 there — a divergence that would
 * show up as the two implementations disagreeing about a number neither of them
 * computed wrongly.
 *
 * Ties are detected on the decimal expansion of the binary double rather than by
 * scaling and comparing, because scaling reintroduces the float error the check
 * is trying to see through.
 */
export const roundHalfEven = (value: number, digits: number): number => {
  if (!Number.isFinite(value)) return value

  const negative = value < 0
  // Far enough past the rounding position to tell a true tie from a value that
  // merely starts with 5; a double's expansion terminates, so trailing zeros
  // here are real.
  const text = Math.abs(value).toFixed(Math.min(100, digits + 25))
  const dot = text.indexOf('.')
  const fraction = text.slice(dot + 1)

  const kept = text.slice(0, dot) + fraction.slice(0, digits)
  const rest = fraction.slice(digits)

  let scaled = BigInt(kept)
  const next = rest.charCodeAt(0) - 48
  const isTie = next === 5 && /^0*$/.test(rest.slice(1))

  if (next > 5 || (next === 5 && !isTie)) scaled += 1n
  else if (isTie && scaled % 2n === 1n) scaled += 1n

  const rounded = Number(scaled) / 10 ** digits
  return negative ? -rounded : rounded
}
