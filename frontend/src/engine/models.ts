/**
 * Core data model, mirroring `tokenlens/models.py`.
 *
 * A `Call` is the unit of *billing* — one request to a model provider.
 * A `Turn` is the unit of *scoring* — one user prompt and every call it caused.
 *
 * Field names stay snake_case rather than being idiomatically renamed. They are
 * simultaneously the rate-table keys and the wire-format category names in
 * `types.ts`, and keeping the three spellings identical is what lets the cost
 * engine index a call by category instead of branching on one.
 */

/**
 * Which shape the source data has.
 *
 * The distinction matters because prompt bloat means different things in each:
 * for `simple` it is an oversized prompt, for `agentic` it is oversized context
 * dragged through the cache on every call of the loop.
 */
export type Profile = 'simple' | 'agentic'

/** One billable request to a model. */
export interface Call {
  model: string
  /** When the call was billed. Null when the source log omits it. */
  timestamp: Date | null
  input_tokens: number
  output_tokens: number
  cache_read: number
  cache_write_5m: number
  cache_write_1h: number
}

/** One user prompt and the calls it caused. */
export interface Turn {
  turn_id: string
  profile: Profile
  timestamp: Date | null
  calls: Call[]
  prompt_text: string | null
  user_id?: string | null
  session_id?: string | null
}

/** A `Call` with every token count defaulted, so callers can supply only what they have. */
export const makeCall = (
  fields: Partial<Call> & Pick<Call, 'model' | 'timestamp'>,
): Call => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read: 0,
  cache_write_5m: 0,
  cache_write_1h: 0,
  ...fields,
})

export const cacheWrite = (call: Call): number =>
  call.cache_write_5m + call.cache_write_1h

export const totalTokens = (call: Call): number =>
  call.input_tokens + call.output_tokens + call.cache_read + cacheWrite(call)

/**
 * Every token charged as input, however it was cached.
 *
 * Used by the overshoot component: the question "what would this have cost on a
 * cheaper model" applies to all input, not just uncached input.
 */
export const billableInputTokens = (call: Call): number =>
  call.input_tokens + call.cache_read + cacheWrite(call)

export const callCount = (turn: Turn): number => turn.calls.length

/**
 * Whether this turn can be classified.
 *
 * Turns without prompt text still count toward spend totals but receive a
 * partial score, flagged as such rather than silently dropped.
 */
export const isScorable = (turn: Turn): boolean =>
  Boolean(turn.prompt_text && turn.prompt_text.trim())

/** Distinct models in first-use order. */
export const modelsUsed = (turn: Turn): string[] => [
  ...new Set(turn.calls.map((call) => call.model)),
]

/** Sum one token category across all calls. */
export const turnTokens = (turn: Turn, kind: keyof Call & string): number =>
  turn.calls.reduce((total, call) => total + (call[kind] as number), 0)
