/**
 * Hand-labelling queue tests.
 *
 * The properties worth pinning are the ones that make the screen honest rather
 * than merely functional: the queue really is cost-ordered, progress really is
 * measured in dollars, turns that can never be labelled are never counted as
 * outstanding work, and a half-made label never reaches the scorer.
 */

import { describe, expect, it } from 'vitest'

import {
  BROWSER_LABEL_MODEL,
  buildLabelQueue,
  firstUnlabelled,
  handLabel,
  isComplete,
  labelProgress,
  shouldAdvance,
  spendCoveredBy,
  toClassifications,
} from './labeling'
import type { PartialLabel } from './labeling'
import { isHuman } from './classification'
import { formatMoney } from './money'
import { makeCall } from './models'
import type { Turn } from './models'

const WHEN = new Date('2026-07-20T00:00:00Z')

const OPUS = 'claude-opus-5'
const HAIKU = 'claude-haiku-4-5'

/** `output` output tokens on one model — enough to make costs differ plainly. */
const turn = (
  turn_id: string,
  output: number,
  options: { model?: string; prompt?: string | null; calls?: number } = {},
): Turn => ({
  turn_id,
  profile: 'agentic',
  timestamp: WHEN,
  prompt_text: options.prompt === undefined ? `prompt for ${turn_id}` : options.prompt,
  session_id: null,
  calls: Array.from({ length: options.calls ?? 1 }, () =>
    makeCall({
      model: options.model ?? OPUS,
      timestamp: WHEN,
      output_tokens: output,
    }),
  ),
})

const labels = (entries: [string, PartialLabel][]) =>
  new Map<string, PartialLabel>(entries)

describe('buildLabelQueue', () => {
  it('orders turns most expensive first', () => {
    const queue = buildLabelQueue([turn('cheap', 10), turn('dear', 1000), turn('mid', 100)])

    expect(queue.tasks.map((task) => task.turn.turn_id)).toEqual(['dear', 'mid', 'cheap'])
  })

  it('sums every call in a turn, not just the first', () => {
    const queue = buildLabelQueue([
      turn('one-big', 900),
      turn('three-small', 400, { calls: 3 }),
    ])

    expect(queue.tasks[0].turn.turn_id).toBe('three-small')
  })

  it('keeps corpus order for turns costing the same', () => {
    const queue = buildLabelQueue([turn('a', 100), turn('b', 100), turn('c', 100)])

    expect(queue.tasks.map((task) => task.turn.turn_id)).toEqual(['a', 'b', 'c'])
  })

  it('excludes turns with no prompt text, but not their spend', () => {
    const queue = buildLabelQueue([turn('labellable', 100), turn('silent', 900, { prompt: null })])

    expect(queue.tasks.map((task) => task.turn.turn_id)).toEqual(['labellable'])
    expect(queue.unlabellable).toBe(1)
    // The silent turn is real money and stays in the file total, so a coverage
    // figure quoted against the file can never claim more than was labelled.
    expect(Number(formatMoney(queue.totalCost))).toBeGreaterThan(
      Number(formatMoney(queue.queueCost)),
    )
  })

  it('treats whitespace-only prompt text as no prompt', () => {
    const queue = buildLabelQueue([turn('blank', 100, { prompt: '   ' })])

    expect(queue.tasks).toEqual([])
    expect(queue.unlabellable).toBe(1)
  })

  it('gives each task its share of queue spend', () => {
    // Opus output is 5x Haiku output, so the split is exactly 5:1.
    const queue = buildLabelQueue([
      turn('dear', 1000, { model: OPUS }),
      turn('cheap', 1000, { model: HAIKU }),
    ])

    expect(queue.tasks[0].share).toBeCloseTo(5 / 6, 6)
    expect(queue.tasks[1].share).toBeCloseTo(1 / 6, 6)
  })

  it('has no queue and no shares for an empty corpus', () => {
    const queue = buildLabelQueue([])

    expect(queue.tasks).toEqual([])
    expect(queue.queueCost).toBe(0n)
    expect(spendCoveredBy(queue, 5)).toBe(0)
  })
})

describe('labelProgress', () => {
  const queue = buildLabelQueue([
    turn('dear', 1000, { model: OPUS }),
    turn('cheap', 1000, { model: HAIKU }),
  ])

  it('measures progress in dollars, not in turns', () => {
    const done = labelProgress(
      queue,
      labels([['dear', { category: 'coding', complexity: 'complex' }]]),
    )

    // Half the turns, but five sixths of the money.
    expect(done.labelled).toBe(1)
    expect(done.total).toBe(2)
    expect(done.spendShare).toBeCloseTo(5 / 6, 6)
  })

  it('does not count a half-made label as labelled', () => {
    const started = labelProgress(
      queue,
      labels([['dear', { category: 'coding', complexity: null }]]),
    )

    expect(started.labelled).toBe(0)
    expect(started.partial).toBe(1)
    expect(started.labelledCost).toBe(0n)
    expect(started.spendShare).toBe(0)
  })

  it('reports file share against every turn, labellable or not', () => {
    const withSilent = buildLabelQueue([
      turn('dear', 1000, { model: OPUS }),
      turn('silent', 1000, { model: OPUS, prompt: null }),
    ])
    const progress = labelProgress(
      withSilent,
      labels([['dear', { category: 'coding', complexity: 'complex' }]]),
    )

    expect(progress.spendShare).toBe(1)
    expect(progress.fileShare).toBeCloseTo(0.5, 6)
  })

  it('ignores labels for turns not in the queue', () => {
    const progress = labelProgress(
      queue,
      labels([['not-here', { category: 'coding', complexity: 'trivial' }]]),
    )

    expect(progress.labelled).toBe(0)
  })
})

describe('toClassifications', () => {
  it('keeps whole labels and drops half-made ones', () => {
    const found = toClassifications(
      labels([
        ['whole', { category: 'research', complexity: 'moderate' }],
        ['half', { category: 'research', complexity: null }],
        ['empty', { category: null, complexity: null }],
      ]),
    )

    expect([...found.keys()]).toEqual(['whole'])
    expect(found.get('whole')).toMatchObject({
      category: 'research',
      complexity: 'moderate',
      confidence: 1,
    })
  })

  it('stamps labels as human so validation refuses to score them against themselves', () => {
    const found = toClassifications(
      labels([['t1', { category: 'coding', complexity: 'complex' }]]),
    )

    expect(found.get('t1')!.model).toBe(BROWSER_LABEL_MODEL)
    expect(isHuman(found.get('t1')!)).toBe(true)
  })

  it('gives every label a rationale, since the leaderboard publishes it', () => {
    expect(handLabel('writing', 'trivial').rationale).not.toBe('')
  })
})

describe('shouldAdvance', () => {
  const whole: PartialLabel = { category: 'coding', complexity: 'complex' }

  it('advances when a choice completes a label', () => {
    expect(shouldAdvance({ category: 'coding', complexity: null }, whole)).toBe(true)
    expect(shouldAdvance({ category: null, complexity: 'complex' }, whole)).toBe(true)
  })

  it('stays put on the first of two choices', () => {
    expect(shouldAdvance(undefined, { category: 'coding', complexity: null })).toBe(false)
  })

  it('stays put when correcting a turn that was already complete', () => {
    expect(shouldAdvance(whole, { ...whole, category: 'research' })).toBe(false)
  })
})

describe('firstUnlabelled', () => {
  const queue = buildLabelQueue([turn('a', 300), turn('b', 200), turn('c', 100)])

  it('resumes at the first gap rather than at the top', () => {
    expect(
      firstUnlabelled(queue, labels([['a', { category: 'coding', complexity: 'complex' }]])),
    ).toBe(1)
  })

  it('skips past a gap that has already been filled', () => {
    expect(
      firstUnlabelled(
        queue,
        labels([
          ['a', { category: 'coding', complexity: 'complex' }],
          ['b', { category: 'coding', complexity: 'trivial' }],
        ]),
      ),
    ).toBe(2)
  })

  it('lands one past the end when nothing is left', () => {
    const done = labels(
      queue.tasks.map((task): [string, PartialLabel] => [
        task.turn.turn_id,
        { category: 'coding', complexity: 'moderate' },
      ]),
    )

    expect(firstUnlabelled(queue, done)).toBe(queue.tasks.length)
  })
})

describe('spendCoveredBy', () => {
  const queue = buildLabelQueue([
    turn('dear', 1000, { model: OPUS }),
    turn('cheap', 1000, { model: HAIKU }),
  ])

  it('accumulates from the expensive end', () => {
    expect(spendCoveredBy(queue, 0)).toBe(0)
    expect(spendCoveredBy(queue, 1)).toBeCloseTo(5 / 6, 6)
    expect(spendCoveredBy(queue, 2)).toBe(1)
  })

  it('does not exceed the queue when asked for more turns than exist', () => {
    expect(spendCoveredBy(queue, 99)).toBe(1)
  })
})

describe('isComplete', () => {
  it('is false for a missing label', () => {
    expect(isComplete(undefined)).toBe(false)
  })
})
