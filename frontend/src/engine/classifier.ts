/**
 * The provider-neutral half of classification.
 *
 * Three modes are planned — hand labelling, Claude, and Gemini — and they differ
 * only in where a `Classification` comes from. Everything around that is the
 * same work, and it is the part that is easy to get subtly wrong in three
 * different ways: cost ordering, progress that means something, stopping without
 * losing what was already paid for, and surviving one bad answer in the middle
 * of a run.
 *
 * So an adapter implements exactly one method — one prompt in, one
 * classification out — and `classifyQueue` does the rest. The interface is
 * defined before the first adapter deliberately: written afterwards it would
 * have been shaped around whatever the first provider happened to make easy.
 *
 * Two decisions are worth stating because they are not the obvious ones.
 *
 * **The runner never sees the API key.** The sketch for this interface passed a
 * key into `classify()`. Holding it in the adapter's closure instead is not
 * merely tidier — the shared code that logs progress, records failure reasons
 * and builds error messages is exactly the code that would leak a key, and it
 * cannot leak what it never receives.
 *
 * **Prompts are classified one at a time, in cost order.** Concurrency would be
 * faster and would break the feature that matters: cost-ordered classification
 * is only a real control if stopping early means the cheap turns are the ones
 * left undone. Four in flight leaves holes in that ordering, and every provider
 * disagrees about how many are acceptable anyway.
 */

import { CATEGORIES, COMPLEXITIES } from './classification'
import type { Category, Classification, Complexity } from './classification'
import { ZERO } from './money'
import type { Money } from './money'
import type { LabelQueue } from './labeling'

/**
 * Ported from `classifier.py`, along with the truncation marker itself.
 *
 * Classification signal lives in the opening of a prompt; a pasted 50k-token
 * file does not make the task harder to categorise, only more expensive to read.
 * Applied here rather than in each adapter so that every provider is shown the
 * same text, which is a precondition for comparing them at all.
 */
export const MAX_PROMPT_CHARS = 6_000

const TRUNCATION_MARKER = '\n[... truncated for classification ...]'

/**
 * The question every provider is asked, ported verbatim from `classifier.py`.
 *
 * This lives here rather than in an adapter because it is the one thing that
 * must not vary between them. These labels are compared against the hand labels
 * and against each other, and two judges answering subtly differently worded
 * questions produce an agreement figure that means nothing.
 * `claude.drift.test.ts` fails if it drifts from the Python.
 */
export const PROMPT_VERSION = '2026-07-26.1'

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

/** The four fields every provider is constrained to return. */
export const RESPONSE_FIELDS = [
  'category',
  'complexity',
  'confidence',
  'rationale',
] as const

/** A provider's raw answer, before validation. */
export interface RawAnswer {
  category: string
  complexity: string
  confidence: number
  rationale: string
}

/**
 * Enough failures in a row to conclude the run is broken rather than unlucky.
 *
 * A rejected key fails every prompt identically. Discovering that by making a
 * hundred requests is slow, and it is not a polite thing to do to someone else's
 * rate limit.
 */
export const MAX_CONSECUTIVE_FAILURES = 3

/**
 * A rough token count, for a pre-flight price only.
 *
 * There is no tokenizer here and pulling one in to show an estimate would cost
 * more than the run it is estimating. Four characters per token is the usual
 * approximation; `MAX_PROMPT_CHARS` bounds how wrong it can be per prompt, and
 * `CostEstimate.approximate` says out loud that it is a guess.
 */
export const CHARS_PER_TOKEN = 4

export const estimatedPromptTokens = (text: string): number =>
  Math.ceil(Math.min(text.trim().length, MAX_PROMPT_CHARS) / CHARS_PER_TOKEN)

/** What a run will cost, quoted before anything is spent. */
export interface CostEstimate {
  /** Null when the backend cannot price itself — a free tier, or an unknown. */
  cost: Money | null
  /** Whether `cost` rests on a token approximation rather than a real count. */
  approximate: boolean
  /** One line for the person about to authorise the spend. */
  note: string
}

/** One way of turning a prompt into a classification. */
export interface ClassifierBackend {
  /** Stable identifier, and the value provenance is reported under. */
  readonly id: string
  /** How the mode is named on screen. */
  readonly label: string
  /**
   * What classifying these prompts will cost. Called before the run, never
   * during it, so it must not touch the network.
   */
  estimate(prompts: string[]): CostEstimate
  /**
   * One prompt to one classification.
   *
   * The prompt arrives already trimmed and truncated. Implementations must
   * honour `signal` and must set `model` to whichever model actually answered —
   * with escalation that is not knowable from outside.
   */
  classify(prompt: string, signal: AbortSignal): Promise<Classification>
}

export interface ClassifyProgress {
  /** Turns classified successfully in this run. */
  done: number
  failed: number
  /** Turns this run set out to cover. */
  total: number
  spendCovered: Money
  /** `spendCovered` against the queue's spend, 0 to 1. */
  spendShare: number
  /** Turn id currently being classified, or null between prompts. */
  inFlight: string | null
}

export interface ClassifyFailure {
  turnId: string
  reason: string
}

export interface ClassifyRun {
  /** Only what this run produced. Merge with existing labels at the call site. */
  classifications: Map<string, Classification>
  failures: ClassifyFailure[]
  /** Whether the run ended early — aborted, or the breaker tripped. */
  stopped: boolean
  /** Set when the circuit breaker tripped, naming the last failure. */
  abandonedBecause: string | null
  /**
   * Queued turns still without a classification, whether because a limit was
   * set, the run was stopped, or a prompt failed. The figure the UI needs to
   * say how much of the corpus remains unmeasured.
   */
  remaining: number
  spendCovered: Money
  spendShare: number
}

export interface ClassifyOptions {
  /**
   * Stop after this many turns. The cost control: the queue is cost-ordered, so
   * a limit buys the most expensive slice of the corpus rather than an arbitrary
   * one.
   */
  limit?: number
  /**
   * Turns already classified — by hand, or by an earlier run. Skipped rather
   * than re-sent, because re-sending them costs money to learn nothing.
   */
  existing?: Map<string, Classification>
  signal?: AbortSignal
  onProgress?: (progress: ClassifyProgress) => void
}

/** Trim and truncate exactly as the Python classifier does. */
export const renderPrompt = (text: string): string => {
  const trimmed = text.trim()
  return trimmed.length > MAX_PROMPT_CHARS
    ? trimmed.slice(0, MAX_PROMPT_CHARS) + TRUNCATION_MARKER
    : trimmed
}

const isCategory = (value: unknown): value is Category =>
  CATEGORIES.includes(value as Category)

const isComplexity = (value: unknown): value is Complexity =>
  COMPLEXITIES.includes(value as Complexity)

/**
 * Check a provider's answer before it reaches the scorer.
 *
 * Structured output is a constraint on the response, not a guarantee about it,
 * and the failure this guards against is quiet: an unrecognised complexity
 * would fall through `REQUIRED_TIER` as `undefined` and price a turn against a
 * tier that does not exist. Every adapter needs this, so it lives here rather
 * than three times over.
 */
export const validateClassification = (value: unknown): Classification => {
  const found = value as Partial<Classification> | null
  if (!found || typeof found !== 'object') {
    throw new ClassificationError('no classification in the response')
  }
  if (!isCategory(found.category)) {
    throw new ClassificationError(`unknown category ${JSON.stringify(found.category)}`)
  }
  if (!isComplexity(found.complexity)) {
    throw new ClassificationError(
      `unknown complexity ${JSON.stringify(found.complexity)}`,
    )
  }
  const confidence = Number(found.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new ClassificationError(
      `confidence ${JSON.stringify(found.confidence)} is not between 0 and 1`,
    )
  }
  if (!found.model) {
    throw new ClassificationError('classification does not say which model produced it')
  }
  return { ...found, confidence } as Classification
}

/** Raised when a provider returns nothing usable. */
export class ClassificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClassificationError'
  }
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Classify a cost-ordered queue, most expensive first.
 *
 * Everything about how this ends is deliberate. Stopping — by abort or by limit
 * — keeps every classification already paid for; discarding them would make the
 * Stop button cost money to press. A prompt that fails is recorded and the run
 * continues, because one malformed answer is not a reason to abandon the other
 * ninety-nine. Failing repeatedly is different, and trips the breaker.
 */
export const classifyQueue = async (
  backend: ClassifierBackend,
  queue: LabelQueue,
  options: ClassifyOptions = {},
): Promise<ClassifyRun> => {
  const { limit, existing, signal, onProgress } = options

  const pending = queue.tasks.filter((task) => !existing?.has(task.turn.turn_id))
  const slice = limit === undefined ? pending : pending.slice(0, Math.max(0, limit))

  const classifications = new Map<string, Classification>()
  const failures: ClassifyFailure[] = []
  // Adapters must be handed a signal, and a run without one should still be
  // able to await them. One inert controller serves every prompt.
  const never = new AbortController().signal
  let spendCovered = ZERO
  let consecutive = 0
  let stopped = false
  let abandonedBecause: string | null = null

  const shareOf = (part: Money): number =>
    queue.queueCost <= ZERO ? 0 : Number(part) / Number(queue.queueCost)

  const report = (inFlight: string | null) =>
    onProgress?.({
      done: classifications.size,
      failed: failures.length,
      total: slice.length,
      spendCovered,
      spendShare: shareOf(spendCovered),
      inFlight,
    })

  report(null)

  for (const task of slice) {
    if (signal?.aborted) {
      stopped = true
      break
    }

    const turnId = task.turn.turn_id
    report(turnId)

    try {
      const found = await backend.classify(
        renderPrompt(task.turn.prompt_text ?? ''),
        signal ?? never,
      )
      classifications.set(turnId, validateClassification(found))
      spendCovered += task.cost
      consecutive = 0
    } catch (error) {
      // An abort surfaces as a rejection from the adapter. It is the person
      // stopping the run, not the run breaking, so it must not count toward the
      // breaker or be reported as a failed prompt.
      if (signal?.aborted) {
        stopped = true
        break
      }
      const reason = reasonOf(error)
      failures.push({ turnId, reason })
      consecutive += 1
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
        stopped = true
        abandonedBecause = reason
        break
      }
    }
  }

  report(null)

  return {
    classifications,
    failures,
    stopped,
    abandonedBecause,
    remaining: pending.length - classifications.size,
    spendCovered,
    spendShare: shareOf(spendCovered),
  }
}
