/**
 * The Claude classifier, in the browser.
 *
 * A port of `backend/tokenlens/classify/classifier.py`: Haiku classifies every
 * prompt, and when it reports low confidence on the complexity call the prompt
 * is re-sent to Sonnet, whose answer wins. Escalation is rare by construction —
 * most prompts are unambiguous — so it stays cheap while protecting the
 * judgement that matters, since complexity drives the required tier and
 * therefore the largest term in the Waste Score.
 *
 * Using the cheapest model that does the job and paying for a stronger one only
 * where it changes the answer is the project's own thesis applied to itself.
 *
 * `SYSTEM_PROMPT`, `USER_TEMPLATE` and `PROMPT_VERSION` are byte-identical to
 * the Python and `claude.drift.test.ts` fails if they drift. That is not
 * tidiness: these labels exist to be compared against the hand labels, and two
 * judges answering subtly different questions would make the agreement figure
 * meaningless.
 *
 * The key lives in this module's closure and nowhere else. `classifyQueue`
 * never receives it, so the shared code that formats progress and failure
 * reasons cannot leak it.
 */

import Anthropic from '@anthropic-ai/sdk'

import { CATEGORIES, COMPLEXITIES } from './classification'
import type { Classification } from './classification'
import {
  CHARS_PER_TOKEN,
  ClassificationError,
  MAX_PROMPT_CHARS,
  estimatedPromptTokens,
  validateClassification,
} from './classifier'
import type { ClassifierBackend, CostEstimate } from './classifier'
import { sum } from './money'
import { makeCall } from './models'
import { defaultTable } from './pricing'
import type { PriceTable } from './pricing'

/**
 * Bump when the instructions change. Part of the Python cache key, kept here so
 * a browser-produced label can be traced to the wording that produced it.
 */
export const PROMPT_VERSION = '2026-07-26.1'

export const BASE_MODEL = 'claude-haiku-4-5'
export const ESCALATION_MODEL = 'claude-sonnet-5'

/** Below this confidence on the complexity call, get a second opinion. */
export const DEFAULT_THRESHOLD = 0.7

export const SYSTEM_PROMPT = `You classify prompts that were sent to AI models, so their cost can be analysed.

Return two independent judgements plus your confidence.

CATEGORY — what the task is. Used for reporting only. It must NOT influence your complexity judgement.
  coding         writing, debugging, reviewing, or explaining code
  research       finding, gathering, comparing, or investigating information
  writing        composing prose, documentation, messages, or creative text
  summarization  condensing or extracting from text the user supplied
  busywork       trivial lookups or chores where using an AI model at all is not justified (checking the weather, simple arithmetic, a definition)

COMPLEXITY — how hard the task is. This is the judgement that matters.
  trivial   single step, no reasoning, no context integration
  moderate  multiple steps, or requires synthesising context the user provided
  complex   extended reasoning, long context, or high stakes for being wrong

Judge complexity by the work required, not by the topic or how the prompt is phrased. A short question can be complex and a long one trivial. Do not assume coding is hard or that writing is easy.

CONFIDENCE — how certain you are about COMPLEXITY specifically, from 0 to 1. Be honest: report low confidence when the prompt is ambiguous, underspecified, or could reasonably be read at two different levels. Low confidence is useful information, not a failure.

RATIONALE — one sentence justifying the complexity call.`

export const renderUserMessage = (prompt: string): string =>
  `Classify this prompt:\n\n<prompt>\n${prompt}\n</prompt>`

/**
 * The shape the model is constrained to return.
 *
 * `additionalProperties: false` and a full `required` list are mandatory for
 * structured outputs. Note what is *absent*: the schema cannot bound
 * `confidence` to [0,1] — numeric constraints are not part of the supported
 * subset — so that bound is enforced by `validateClassification` on the way in.
 * A schema is a constraint on the shape of the reply, not a guarantee about its
 * contents.
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: CATEGORIES },
    complexity: { type: 'string', enum: COMPLEXITIES },
    confidence: {
      type: 'number',
      description: 'Certainty about the complexity call specifically, 0 to 1.',
    },
    rationale: {
      type: 'string',
      description: 'One sentence explaining the complexity call.',
    },
  },
  required: ['category', 'complexity', 'confidence', 'rationale'],
  additionalProperties: false,
} as const

/**
 * Generous for a four-field object with a one-sentence rationale, and small
 * enough that a runaway reply costs nothing. Hitting the cap truncates the JSON
 * mid-object, which surfaces as a parse failure rather than a wrong label.
 */
const MAX_TOKENS = 1024

/** What a classification reply costs, near enough to quote before spending. */
const ESTIMATED_OUTPUT_TOKENS = 120

/**
 * Share of prompts expected to escalate to Sonnet.
 *
 * From the Python's own design note: escalation is rare because most prompts
 * are unambiguous. The estimate is a range, and the screen says so — a figure
 * quoted to the cent would imply a precision this does not have.
 */
const ESCALATION_RATE = 0.2

/** One request to one model. Injectable so tests never need a key or a socket. */
export type Send = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  options: { signal: AbortSignal },
) => Promise<Anthropic.Message>

export interface ClaudeOptions {
  threshold?: number
  baseModel?: string
  escalationModel?: string
  table?: PriceTable
  /** Replaces the network entirely. Production supplies none. */
  send?: Send
}

/**
 * Per-model request differences, both verified against current SDK typings.
 *
 * Sonnet 5 runs **adaptive thinking by default** when `thinking` is omitted —
 * a change from Sonnet 4.6. For a one-shot classification that buys nothing and
 * bills thinking tokens on every escalation, so it is disabled explicitly and
 * effort is dropped to `low`. Haiku 4.5 accepts neither field: it has no
 * adaptive thinking, and `effort` is rejected outright. Sending one config to
 * both models would either overpay on Sonnet or error on Haiku.
 */
const requestFor = (
  model: string,
  prompt: string,
): Anthropic.MessageCreateParamsNonStreaming => {
  const base: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: renderUserMessage(prompt) }],
    output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
  }
  if (model === BASE_MODEL) return base
  return {
    ...base,
    thinking: { type: 'disabled' },
    output_config: { ...base.output_config, effort: 'low' },
  }
}

/**
 * Read the reply, or say why it cannot be read.
 *
 * Two stop reasons must not be parsed as answers. `refusal` means the safety
 * classifiers declined and the content does not follow the schema; `max_tokens`
 * means the JSON is cut off mid-object. Both would otherwise surface as a
 * confusing parse error several frames away from the cause.
 */
const readReply = (message: Anthropic.Message, model: string): unknown => {
  if (message.stop_reason === 'refusal') {
    throw new ClassificationError(`${model} declined to classify this prompt`)
  }
  if (message.stop_reason === 'max_tokens') {
    throw new ClassificationError(
      `${model} hit the ${MAX_TOKENS}-token cap before finishing its answer`,
    )
  }

  const text = message.content.find((block) => block.type === 'text')
  if (!text || text.type !== 'text') {
    throw new ClassificationError(`${model} returned no text to parse`)
  }
  try {
    return JSON.parse(text.text)
  } catch {
    throw new ClassificationError(`${model} returned text that is not JSON`)
  }
}

interface Reply {
  category: string
  complexity: string
  confidence: number
  rationale: string
}

/**
 * The Claude adapter.
 *
 * `key` is captured here and never passed onward — `classifyQueue` does the
 * ordering, progress, stopping and failure handling without ever seeing it.
 */
export const createClaudeBackend = (
  key: string,
  options: ClaudeOptions = {},
): ClassifierBackend => {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  const baseModel = options.baseModel ?? BASE_MODEL
  const escalationModel = options.escalationModel ?? ESCALATION_MODEL
  const table = options.table ?? defaultTable()

  // Built on first send, not here: `estimate()` must work before a key has been
  // typed, so constructing a backend can never require a usable one.
  let client: Anthropic | null = null
  const send: Send =
    options.send ??
    ((params, requestOptions) => {
      // `dangerouslyAllowBrowser` is exactly as advertised: it ships a key to
      // the client. It is defensible only because the key is the visitor's own,
      // typed into their own browser, held in sessionStorage and sent nowhere
      // but Anthropic. It would not be defensible for a key of ours.
      client ??= new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true })
      return client.messages.create(params, requestOptions)
    })

  const ask = async (model: string, prompt: string, signal: AbortSignal) => {
    const message = await send(requestFor(model, prompt), { signal })
    return readReply(message, model) as Reply
  }

  return {
    id: 'claude',
    label: 'Claude — Haiku 4.5, escalating to Sonnet 5',

    estimate: (prompts) => estimateFor(prompts, table, baseModel, escalationModel),

    async classify(prompt, signal) {
      const base = await ask(baseModel, prompt, signal)

      if (Number(base.confidence) >= threshold) {
        return validateClassification({ ...base, model: baseModel } as Classification)
      }

      // Sonnet's answer wins outright, but the first one is kept alongside it.
      // Validation reports agreement both before and after escalation, and an
      // improving figure is only a result if the earlier answer survived.
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
 * What a run will cost, priced by the same engine that measures the waste.
 *
 * Reusing `PriceTable` rather than hardcoding rates is not just tidiness: it
 * picks up Sonnet 5's promotional window automatically, so the quote tracks the
 * rate sheet the project already publishes instead of a second copy that can
 * drift from it.
 */
const estimateFor = (
  prompts: string[],
  table: PriceTable,
  baseModel: string,
  escalationModel: string,
): CostEstimate => {
  const now = new Date()
  const overhead = Math.ceil(
    (SYSTEM_PROMPT.length + renderUserMessage('').length) / CHARS_PER_TOKEN,
  )

  const callFor = (model: string, prompt: string) =>
    makeCall({
      model,
      timestamp: now,
      input_tokens: overhead + estimatedPromptTokens(prompt),
      output_tokens: ESTIMATED_OUTPUT_TOKENS,
    })

  const everyPrompt = sum(prompts.map((p) => table.costOf(callFor(baseModel, p))))

  // Escalation is charged over the whole corpus at its expected rate rather
  // than guessing which prompts will be the ambiguous ones.
  const escalations = sum(
    prompts.map((p) => table.costOf(callFor(escalationModel, p))),
  )
  const escalationShare =
    (escalations * BigInt(Math.round(ESCALATION_RATE * 100))) / 100n

  return {
    cost: everyPrompt + escalationShare,
    approximate: true,
    note:
      `${prompts.length} prompt${prompts.length === 1 ? '' : 's'} on Haiku 4.5, with about ` +
      `${Math.round(ESCALATION_RATE * 100)}% escalating to Sonnet 5. Token counts are ` +
      `estimated at ${CHARS_PER_TOKEN} characters each and prompts are truncated to ` +
      `${MAX_PROMPT_CHARS.toLocaleString('en-US')} characters, so treat this as a ceiling ` +
      `on the order of magnitude, not a quote.`,
  }
}
