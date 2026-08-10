/**
 * Provenance tests.
 *
 * The claim this defends is narrow and load-bearing: every waste figure on
 * screen can be traced to who produced the labels under it. That breaks in two
 * quiet ways — attributing turns to a model that did not judge them, and
 * silently losing attribution when reading a snapshot frozen before the field
 * existed — so both are pinned here.
 */

import { describe, expect, it } from 'vitest'

import { normalizeSource } from '../api'
import { buildAnalysis, scoreTurns } from './analysis'
import { HUMAN_MODEL_PREFIX } from './classification'
import type { Classification } from './classification'
import { makeCall } from './models'
import type { Turn } from './models'

const WHEN = new Date('2026-07-20T00:00:00Z')

const turn = (turn_id: string): Turn => ({
  turn_id,
  profile: 'agentic',
  timestamp: WHEN,
  prompt_text: `prompt ${turn_id}`,
  session_id: null,
  calls: [makeCall({ model: 'claude-opus-5', timestamp: WHEN, output_tokens: 500 })],
})

const by = (model: string): Classification => ({
  category: 'coding',
  complexity: 'trivial',
  confidence: 0.9,
  rationale: 'r',
  model,
})

const HUMAN = `${HUMAN_MODEL_PREFIX}browser`

/** Score a corpus and hand back just its provenance. */
const sourceOf = (labels: Record<string, string>) => {
  const turns = Object.keys(labels).map(turn)
  const classifications = new Map(
    Object.entries(labels).map(([id, model]) => [id, by(model)]),
  )
  const { scores } = scoreTurns(turns, classifications)
  return buildAnalysis(turns, { classifications, scores }).waste!.source
}

describe('who produced the labels', () => {
  it('reports hand labels as such, naming no model', () => {
    const source = sourceOf({ a: HUMAN, b: HUMAN })

    expect(source.kind).toBe('hand-labelled')
    expect(source.human_turns).toBe(2)
    // Naming a model here would attribute a person's judgement to software.
    expect(source.models).toEqual([])
  })

  it('names every model a classifier run used, most-used first', () => {
    const source = sourceOf({
      a: 'claude-haiku-4-5',
      b: 'claude-haiku-4-5',
      c: 'claude-haiku-4-5',
      d: 'claude-sonnet-5',
    })

    expect(source.kind).toBe('classifier')
    expect(source.human_turns).toBe(0)
    expect(source.models).toEqual([
      { model: 'claude-haiku-4-5', turns: 3 },
      { model: 'claude-sonnet-5', turns: 1 },
    ])
  })

  it('distinguishes two providers rather than calling both "classifier"', () => {
    // The whole reason the field stopped being one word: these are different
    // measurements and used to render identically.
    const source = sourceOf({
      a: 'claude-haiku-4-5',
      b: 'gemini-3.5-flash-lite',
      c: 'gemini-3.5-flash-lite',
    })

    expect(source.models).toEqual([
      { model: 'gemini-3.5-flash-lite', turns: 2 },
      { model: 'claude-haiku-4-5', turns: 1 },
    ])
  })

  it('keeps first-seen order when two models tie', () => {
    const source = sourceOf({ a: 'claude-haiku-4-5', b: 'gemini-3.5-flash-lite' })

    // Stable, so the same corpus renders the same line every time.
    expect(source.models.map((entry) => entry.model)).toEqual([
      'claude-haiku-4-5',
      'gemini-3.5-flash-lite',
    ])
  })

  it('reports a part-human corpus as mixed and counts the human turns', () => {
    const source = sourceOf({ a: HUMAN, b: 'claude-haiku-4-5', c: 'claude-haiku-4-5' })

    expect(source.kind).toBe('mixed')
    expect(source.human_turns).toBe(1)
    // The hand-labelled turn is not folded into the model's count.
    expect(source.models).toEqual([{ model: 'claude-haiku-4-5', turns: 2 }])
  })

  it('ignores classifications for turns that were never scored', () => {
    const turns = [turn('a')]
    const classifications = new Map([
      ['a', by('claude-haiku-4-5')],
      // A label left over from a bigger corpus. It describes nothing on screen.
      ['ghost', by('gemini-3.5-flash-lite')],
    ])
    const { scores } = scoreTurns(turns, classifications)

    const source = buildAnalysis(turns, { classifications, scores }).waste!.source

    expect(source.models).toEqual([{ model: 'claude-haiku-4-5', turns: 1 }])
  })
})

describe('reading a snapshot frozen before this field grew', () => {
  it('accepts the single word older snapshots carry', () => {
    // The published demo snapshot is exactly this shape.
    expect(normalizeSource('hand-labelled')).toEqual({
      kind: 'hand-labelled',
      models: [],
    })
  })

  it('leaves the count absent rather than inventing one', () => {
    // A legacy snapshot genuinely does not know how many turns a person judged.
    expect(normalizeSource('mixed').human_turns).toBeUndefined()
  })

  it('passes a current source through untouched', () => {
    const source = {
      kind: 'classifier' as const,
      models: [{ model: 'claude-haiku-4-5', turns: 3 }],
      human_turns: 0,
    }

    expect(normalizeSource(source)).toEqual(source)
  })

  it('survives a payload with no source at all', () => {
    expect(normalizeSource(undefined)).toEqual({ kind: 'classifier', models: [] })
  })
})
