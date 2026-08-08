/**
 * Runner tests for the provider-neutral classification layer.
 *
 * There is no adapter yet, and that is the point of testing here: everything
 * pinned below is behaviour each adapter would otherwise have to re-implement
 * and re-justify. The stakes are money and trust — a run that discards paid-for
 * answers when stopped, one that abandons ninety-nine prompts over one bad
 * reply, or one that lets an unrecognised complexity reach the scorer are all
 * plausible implementations that look fine until they are not.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  ClassificationError,
  MAX_CONSECUTIVE_FAILURES,
  MAX_PROMPT_CHARS,
  classifyQueue,
  estimatedPromptTokens,
  renderPrompt,
  validateClassification,
} from './classifier'
import type { ClassifierBackend, ClassifyProgress } from './classifier'
import type { Category, Classification, Complexity } from './classification'
import { buildLabelQueue } from './labeling'
import { makeCall } from './models'
import type { Turn } from './models'

const WHEN = new Date('2026-07-20T00:00:00Z')

const OPUS = 'claude-opus-5'
const HAIKU = 'claude-haiku-4-5'

const turn = (turn_id: string, output: number, model = OPUS): Turn => ({
  turn_id,
  profile: 'agentic',
  timestamp: WHEN,
  prompt_text: `prompt for ${turn_id}`,
  session_id: null,
  calls: [makeCall({ model, timestamp: WHEN, output_tokens: output })],
})

const found = (
  overrides: Partial<Classification> = {},
): Classification => ({
  category: 'coding',
  complexity: 'moderate',
  confidence: 0.9,
  rationale: 'because',
  model: 'test-model',
  ...overrides,
})

/** A backend whose every answer is scripted, recording what it was asked. */
const backendOf = (
  answer: (prompt: string, seen: number) => Classification | Promise<Classification>,
): ClassifierBackend & { seen: string[] } => {
  const seen: string[] = []
  return {
    id: 'test',
    label: 'Test',
    seen,
    estimate: () => ({ cost: null, approximate: true, note: 'free' }),
    async classify(prompt) {
      seen.push(prompt)
      return answer(prompt, seen.length - 1)
    },
  }
}

/** Three turns, deliberately unequal: $0.025 / $0.005 / $0.001 in queue order. */
const queue = () =>
  buildLabelQueue([turn('cheap', 200, HAIKU), turn('dear', 1000), turn('mid', 200)])

describe('classifyQueue', () => {
  it('classifies most expensive first', async () => {
    const backend = backendOf(() => found())
    const run = await classifyQueue(backend, queue())

    expect([...run.classifications.keys()]).toEqual(['dear', 'mid', 'cheap'])
    expect(backend.seen).toEqual([
      'prompt for dear',
      'prompt for mid',
      'prompt for cheap',
    ])
  })

  it('buys the expensive end of the corpus when limited', async () => {
    const run = await classifyQueue(backendOf(() => found()), queue(), { limit: 1 })

    expect([...run.classifications.keys()]).toEqual(['dear'])
    expect(run.remaining).toBe(2)
    // One of three turns, but the great majority of the money.
    expect(run.spendShare).toBeGreaterThan(0.8)
  })

  it('does not re-send turns that are already labelled', async () => {
    const backend = backendOf(() => found())
    const run = await classifyQueue(backend, queue(), {
      existing: new Map([['dear', found()]]),
    })

    expect(backend.seen).toEqual(['prompt for mid', 'prompt for cheap'])
    // The run reports only what it produced; merging is the caller's business.
    expect([...run.classifications.keys()]).toEqual(['mid', 'cheap'])
  })

  it('keeps everything already paid for when stopped', async () => {
    const controller = new AbortController()
    const backend = backendOf((_prompt, seen) => {
      if (seen === 0) controller.abort()
      return found()
    })

    const run = await classifyQueue(backend, queue(), { signal: controller.signal })

    // The first answer arrived and was banked; the rest were never requested.
    expect([...run.classifications.keys()]).toEqual(['dear'])
    expect(run.stopped).toBe(true)
    expect(run.remaining).toBe(2)
  })

  it('treats an abort raised by the adapter as a stop, not a failure', async () => {
    const controller = new AbortController()
    const backend = backendOf(() => {
      controller.abort()
      throw new Error('The operation was aborted')
    })

    const run = await classifyQueue(backend, queue(), { signal: controller.signal })

    expect(run.stopped).toBe(true)
    expect(run.failures).toEqual([])
    expect(run.abandonedBecause).toBeNull()
  })

  it('carries on past one bad answer', async () => {
    const backend = backendOf((_prompt, seen) => {
      if (seen === 0) throw new Error('rate limited')
      return found()
    })

    const run = await classifyQueue(backend, queue())

    expect([...run.classifications.keys()]).toEqual(['mid', 'cheap'])
    expect(run.failures).toEqual([{ turnId: 'dear', reason: 'rate limited' }])
    expect(run.stopped).toBe(false)
    expect(run.remaining).toBe(1)
  })

  it('gives up rather than spend a whole corpus failing the same way', async () => {
    const many = buildLabelQueue(
      Array.from({ length: 20 }, (_unused, index) => turn(`t${index}`, 100)),
    )
    const backend = backendOf(() => {
      throw new Error('401 invalid x-api-key')
    })

    const run = await classifyQueue(backend, many)

    expect(backend.seen).toHaveLength(MAX_CONSECUTIVE_FAILURES)
    expect(run.stopped).toBe(true)
    expect(run.abandonedBecause).toBe('401 invalid x-api-key')
  })

  it('resets the breaker on a success between failures', async () => {
    const backend = backendOf((_prompt, seen) => {
      if (seen % 2 === 0) throw new Error('flaky')
      return found()
    })

    const run = await classifyQueue(backend, queue())

    expect(run.stopped).toBe(false)
    expect(run.failures).toHaveLength(2)
    expect(run.classifications.size).toBe(1)
  })

  it('reports progress in dollars, ending where the queue does', async () => {
    const seen: ClassifyProgress[] = []
    await classifyQueue(backendOf(() => found()), queue(), {
      onProgress: (progress) => seen.push({ ...progress }),
    })

    expect(seen[0]).toMatchObject({ done: 0, spendShare: 0, inFlight: null })
    expect(seen.at(-1)).toMatchObject({ done: 3, spendShare: 1, inFlight: null })
    // Monotonic: a progress bar that goes backwards is worse than none.
    const shares = seen.map((progress) => progress.spendShare)
    expect([...shares].sort((a, b) => a - b)).toEqual(shares)
  })

  it('names the turn in flight so a slow prompt is visible', async () => {
    const inFlight: (string | null)[] = []
    await classifyQueue(backendOf(() => found()), queue(), {
      limit: 1,
      onProgress: (progress) => inFlight.push(progress.inFlight),
    })

    expect(inFlight).toContain('dear')
  })

  it('rejects an unusable answer as a failure rather than scoring it', async () => {
    const backend = backendOf(() => found({ complexity: 'medium' as Complexity }))

    const run = await classifyQueue(backend, queue(), { limit: 1 })

    expect(run.classifications.size).toBe(0)
    expect(run.failures[0].reason).toContain('unknown complexity')
  })

  it('does nothing, successfully, on an empty queue', async () => {
    const backend = backendOf(() => found())
    const run = await classifyQueue(backend, buildLabelQueue([]))

    expect(backend.seen).toEqual([])
    expect(run).toMatchObject({ stopped: false, remaining: 0, spendShare: 0 })
  })

  it('shows every adapter the same text', async () => {
    const long = { ...turn('long', 100), prompt_text: `  ${'x'.repeat(9_000)}  ` }
    const backend = backendOf(() => found())

    await classifyQueue(backend, buildLabelQueue([long]))

    expect(backend.seen[0]).toBe(renderPrompt(long.prompt_text!))
    expect(backend.seen[0].startsWith('x')).toBe(true)
    expect(backend.seen[0]).toContain('truncated for classification')
  })
})

describe('renderPrompt', () => {
  it('trims without truncating a prompt that fits', () => {
    expect(renderPrompt('  hello  ')).toBe('hello')
  })

  it('keeps the opening, which is where the signal is', () => {
    const rendered = renderPrompt('a'.repeat(MAX_PROMPT_CHARS + 500))

    expect(rendered.slice(0, MAX_PROMPT_CHARS)).toBe('a'.repeat(MAX_PROMPT_CHARS))
    expect(rendered).toContain('truncated for classification')
  })
})

describe('estimatedPromptTokens', () => {
  it('caps at the truncation length, so a huge paste is not quoted as huge', () => {
    const capped = Math.ceil(MAX_PROMPT_CHARS / 4)

    expect(estimatedPromptTokens('x'.repeat(MAX_PROMPT_CHARS * 10))).toBe(capped)
    expect(estimatedPromptTokens('x'.repeat(400))).toBe(100)
  })
})

describe('validateClassification', () => {
  it('accepts a well-formed answer unchanged', () => {
    expect(validateClassification(found())).toMatchObject({
      category: 'coding',
      complexity: 'moderate',
    })
  })

  it('refuses a category the schema does not define', () => {
    expect(() => validateClassification(found({ category: 'devops' as Category }))).toThrow(
      ClassificationError,
    )
  })

  it('refuses confidence outside 0 to 1', () => {
    expect(() => validateClassification(found({ confidence: 1.4 }))).toThrow(/between 0 and 1/)
    expect(() => validateClassification(found({ confidence: Number.NaN }))).toThrow()
  })

  it('refuses an answer that will not say which model produced it', () => {
    expect(() => validateClassification(found({ model: '' }))).toThrow(/which model/)
  })

  it('refuses nothing at all', () => {
    expect(() => validateClassification(null)).toThrow(ClassificationError)
    expect(() => validateClassification(undefined)).toThrow(ClassificationError)
  })

  it('coerces a numeric-string confidence rather than rejecting it', () => {
    // Providers have been known to quote numbers in JSON. The value is
    // unambiguous, so this is leniency about spelling, not about meaning.
    expect(validateClassification(found({ confidence: '0.8' as unknown as number }))).toMatchObject(
      { confidence: 0.8 },
    )
  })
})

describe('backend contract', () => {
  it('never receives an API key from the runner', async () => {
    // Nothing in the run signature can carry one, which is the point: the code
    // that formats progress and failure reasons cannot leak what it never sees.
    const classify = vi.fn(async () => found())
    const backend: ClassifierBackend = {
      id: 'test',
      label: 'Test',
      estimate: () => ({ cost: null, approximate: false, note: '' }),
      classify,
    }

    await classifyQueue(backend, queue(), { limit: 1 })

    expect(classify).toHaveBeenCalledWith('prompt for dear', expect.any(AbortSignal))
  })
})
