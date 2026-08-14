/**
 * The conversion prompt is shipped copy, and the thing it must never do is
 * invite a model to make up numbers. A chat assistant cannot see anyone's
 * billing account, so a prompt that reads as "produce a usage CSV" gets
 * plausible fiction — which this tool would then price, and report a waste
 * score on. These pin the properties that keep it a converter.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { CANONICAL_HEADER, detectColumns, MAPPABLE_FIELDS } from '../engine/csvIngest'
import { CSV_PROMPT } from './csvPrompt'

describe('the CSV conversion prompt', () => {
  it('asks for exactly the header the parser detects', () => {
    const header = CANONICAL_HEADER.join(',')

    expect(CSV_PROMPT).toContain(header)
    // And that header really does resolve, so the instruction is not merely
    // self-consistent — it is correct.
    const mapping = detectColumns([...CANONICAL_HEADER])
    expect(MAPPABLE_FIELDS.some((f) => mapping[f.field] !== null)).toBe(true)
  })

  it('forbids invented values in as many words', () => {
    const text = CSV_PROMPT.toLowerCase()

    expect(text).toContain('never estimate, infer, or invent')
    expect(text).toMatch(/empty cell is correct/)
  })

  it('tells the model not to add or drop rows', () => {
    expect(CSV_PROMPT.toLowerCase()).toContain('do not add, merge, or drop rows')
  })

  it('warns about the cache double-count', () => {
    // The single subtlest thing in the whole ingest path: OpenAI's prompt
    // tokens include cached ones and Anthropic's input tokens do not. Getting
    // it wrong doubles exactly the traffic that dominates agentic spend.
    expect(CSV_PROMPT).toContain('EXCLUDING anything served from cache')
    expect(CSV_PROMPT.toLowerCase()).toContain('subtract them here')
  })

  it('asks for one row per request, not per conversation', () => {
    expect(CSV_PROMPT.toLowerCase()).toContain('one row per api request')
  })

  it('asks for raw CSV, since a code fence would have to be stripped by hand', () => {
    expect(CSV_PROMPT.toLowerCase()).toContain('no markdown code fence')
  })

  it('ends by handing over to the export, so paste order is unambiguous', () => {
    expect(CSV_PROMPT.trimEnd().endsWith('Here is my export:')).toBe(true)
  })
})

describe('the README quotes this header', () => {
  // The README repeats the header for a reader who never opens the app. It was
  // copied by hand, so it can rot silently — and a header printed in the
  // project's own documentation that the project's own parser does not detect
  // is the most confusing possible way to fail.
  const README = fileURLToPath(new URL('../../../README.md', import.meta.url))

  it('reproduces CANONICAL_HEADER exactly', () => {
    const readme = readFileSync(README, 'utf8')

    expect(readme).toContain(CANONICAL_HEADER.join(','))
  })
})
