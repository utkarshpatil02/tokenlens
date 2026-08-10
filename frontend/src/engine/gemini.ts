/**
 * The Gemini classifier, in the browser.
 *
 * Same two-stage shape as the Claude adapter — Flash-Lite reads every prompt and
 * Flash gets a second opinion where the first is unsure — asking the identical
 * question from `classifier.ts`, which is what makes the two providers
 * comparable at all.
 *
 * Three things are genuinely different here, and each was checked rather than
 * recalled.
 *
 * **Raw `fetch`, no SDK.** `@google/genai`'s current documented surface is
 * `interactions.create`, and it is *unusable from a browser*: the client sets an
 * `Api-Revision` request header, `generativelanguage.googleapis.com` does not
 * list that header in `Access-Control-Allow-Headers`, and the preflight comes
 * back 403 with no `Access-Control-Allow-Origin` (googleapis/js-genai#1723, open
 * at the time of writing). The older `models.generateContent` path works in the
 * browser precisely because it never sets that header — so this calls that
 * endpoint directly. A verified 400 `API_KEY_INVALID` read back from the page
 * confirms the preflight passes. Going through the SDK would mean shipping a
 * dependency whose main path is broken in the only environment we run in.
 *
 * **A different schema dialect.** Gemini takes an OpenAPI-flavoured schema with
 * uppercase type names under `generationConfig.responseSchema`, not JSON Schema
 * under `output_config.format`. `propertyOrdering` is honoured, and there is no
 * `additionalProperties`.
 *
 * **Rate limits are the normal case, not a failure.** Free-tier limits are not
 * published — Google directs you to AI Studio for your own — so this cannot pace
 * itself against a known number. Instead a 429 or 503 is retried here with
 * backoff, and only a genuinely dead request is handed to `classifyQueue`. That
 * matters: the runner's three-strike breaker exists to stop a rejected key from
 * costing a hundred requests, and it would trip on an ordinary free-tier rate
 * limit if the adapter passed one through as a failure.
 */

import { CATEGORIES, COMPLEXITIES } from './classification'
import type { Classification } from './classification'
import {
  ClassificationError,
  RESPONSE_FIELDS,
  SYSTEM_PROMPT,
  renderUserMessage,
  validateClassification,
} from './classifier'
import type { ClassifierBackend, CostEstimate, RawAnswer } from './classifier'

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

/** Cheapest and fastest of the current generation; the workhorse. */
export const BASE_MODEL = 'gemini-3.5-flash-lite'
/** Same generation, a clear step up in capability, for the ambiguous ones. */
export const ESCALATION_MODEL = 'gemini-3.5-flash'

/** Matches the Claude adapter and the Python, so escalation means one thing. */
export const DEFAULT_THRESHOLD = 0.7

/** Retried, not reported: the free tier hands these out in normal operation. */
const RETRYABLE_STATUS = new Set([429, 500, 503])

export const MAX_RETRIES = 4

/** Doubling from here, so four retries span roughly a minute. */
const BASE_BACKOFF_MS = 2_000

/**
 * Gemini's schema dialect: uppercase types, no `additionalProperties`.
 *
 * `propertyOrdering` is not decoration — Gemini honours it, and a stable field
 * order keeps replies comparable between runs. As with Claude, the schema cannot
 * bound `confidence` to [0,1]; `validateClassification` does that.
 */
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    category: { type: 'STRING', enum: CATEGORIES },
    complexity: { type: 'STRING', enum: COMPLEXITIES },
    confidence: {
      type: 'NUMBER',
      description: 'Certainty about the complexity call specifically, 0 to 1.',
    },
    rationale: {
      type: 'STRING',
      description: 'One sentence explaining the complexity call.',
    },
  },
  required: RESPONSE_FIELDS,
  propertyOrdering: RESPONSE_FIELDS,
}

/** Minimal shapes for the fields this adapter actually reads. */
interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] }
    finishReason?: string
  }[]
  promptFeedback?: { blockReason?: string }
  error?: { message?: string; status?: string }
}

export type Fetch = typeof globalThis.fetch

export interface GeminiOptions {
  threshold?: number
  baseModel?: string
  escalationModel?: string
  maxRetries?: number
  /** Replaces the network. Tests supply one; production supplies none. */
  fetchImpl?: Fetch
  /** Swapped out in tests so backoff does not really sleep. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('The operation was aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

const requestBody = (prompt: string) => ({
  systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
  contents: [{ role: 'user', parts: [{ text: renderUserMessage(prompt) }] }],
  generationConfig: {
    responseMimeType: 'application/json',
    responseSchema: RESPONSE_SCHEMA,
  },
})

/**
 * Pull the answer out, or say precisely why there isn't one.
 *
 * Gemini reports a refused prompt in two different places depending on whether
 * the input or the output tripped a filter, and a truncated reply only as a
 * `finishReason`. All three produce content that is not the schema, so none may
 * be parsed as an answer.
 */
const readReply = (body: GeminiResponse, model: string): unknown => {
  if (body.promptFeedback?.blockReason) {
    throw new ClassificationError(
      `${model} blocked the prompt (${body.promptFeedback.blockReason})`,
    )
  }

  const candidate = body.candidates?.[0]
  if (!candidate) throw new ClassificationError(`${model} returned no candidates`)

  const finish = candidate.finishReason
  if (finish && finish !== 'STOP') {
    throw new ClassificationError(`${model} stopped early (${finish})`)
  }

  const text = candidate.content?.parts?.map((part) => part.text ?? '').join('')
  if (!text) throw new ClassificationError(`${model} returned no text to parse`)

  try {
    return JSON.parse(text)
  } catch {
    throw new ClassificationError(`${model} returned text that is not JSON`)
  }
}

/** Seconds from a `Retry-After` header, when the server bothered to say. */
const retryAfterMs = (response: Response): number | null => {
  const header = response.headers?.get?.('retry-after')
  if (!header) return null
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null
}

/**
 * The Gemini adapter.
 *
 * `key` is captured here and never passed onward, for the same reason as the
 * Claude adapter: the shared code that formats progress and failure reasons is
 * exactly the code that would leak it.
 */
export const createGeminiBackend = (
  key: string,
  options: GeminiOptions = {},
): ClassifierBackend => {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  const baseModel = options.baseModel ?? BASE_MODEL
  const escalationModel = options.escalationModel ?? ESCALATION_MODEL
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  const doFetch = options.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const wait = options.wait ?? sleep

  const ask = async (
    model: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<RawAnswer> => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await doFetch(`${ENDPOINT}/${model}:generateContent`, {
        method: 'POST',
        // `x-goog-api-key` rather than a `?key=` query parameter: a key in a URL
        // ends up in history, logs and referrers.
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(requestBody(prompt)),
        signal,
      })

      if (response.ok) return readReply(await response.json(), model) as RawAnswer

      const body = (await response.json().catch(() => ({}))) as GeminiResponse
      const detail = body.error?.message ?? response.statusText ?? ''

      if (!RETRYABLE_STATUS.has(response.status) || attempt >= maxRetries) {
        throw new ClassificationError(
          `${model} returned ${response.status}${detail ? `: ${detail}` : ''}`,
        )
      }

      // Exponential, and the server's own figure wins when it gives one.
      await wait(
        retryAfterMs(response) ?? BASE_BACKOFF_MS * 2 ** attempt,
        signal,
      )
    }
  }

  return {
    id: 'gemini',
    label: 'Gemini — 3.5 Flash-Lite, escalating to 3.5 Flash',

    estimate,

    async classify(prompt, signal) {
      const base = await ask(baseModel, prompt, signal)

      if (Number(base.confidence) >= threshold) {
        return validateClassification({ ...base, model: baseModel } as Classification)
      }

      const escalated = await ask(escalationModel, prompt, signal)
      return validateClassification({
        ...escalated,
        model: escalationModel,
        escalated: true,
        base_category: base.category,
        base_complexity: base.complexity,
        base_confidence: Number(base.confidence),
      } as Classification)
    },
  }
}

/**
 * No figure, deliberately.
 *
 * Gemini has a free tier, so for most people this run costs nothing — but the
 * same key on a paid tier bills per token, and this page cannot tell which one
 * it is holding. `null` is the honest answer, and it is why `CostEstimate.cost`
 * is nullable: quoting "$0" to someone whose project is on a paid tier would be
 * the one thing this project is careful never to do.
 */
const estimate = (prompts: string[]): CostEstimate => ({
  cost: null,
  approximate: true,
  note:
    `${prompts.length} prompt${prompts.length === 1 ? '' : 's'} on Gemini 3.5 Flash-Lite, ` +
    `escalating to Flash where the first answer is unsure. Free within Google's rate ` +
    `limits — but this page cannot tell whether your key is on the free tier or a paid ` +
    `one, so it will not quote you a price. Free-tier limits are low and not published; ` +
    `rate-limited requests are retried with backoff, so a long run is slow rather than ` +
    `broken.`,
})
