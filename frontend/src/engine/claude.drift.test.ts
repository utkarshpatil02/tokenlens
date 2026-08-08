/**
 * Cross-engine guard for the classifier's question.
 *
 * The four golden fixtures keep the two engines' *arithmetic* in step. Nothing
 * kept the thing the classifier is actually asked in step, and that matters
 * more than it looks: these labels exist to be compared against the 65 hand
 * labels and against each other, and two judges answering subtly differently
 * worded questions produce an agreement figure that means nothing. A reworded
 * system prompt is also a silent change — every request still succeeds.
 *
 * So this reads the Python source directly. No generated fixture to regenerate
 * and no build step: edit `classifier.py` without editing `claude.ts` and this
 * goes red.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  BASE_MODEL,
  DEFAULT_THRESHOLD,
  ESCALATION_MODEL,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  renderUserMessage,
} from './claude'
import { MAX_PROMPT_CHARS } from './classifier'

const PYTHON = fileURLToPath(
  new URL('../../../backend/tokenlens/classify/classifier.py', import.meta.url),
)

// Normalized so a CRLF checkout on Windows compares equal to the LF source.
const source = readFileSync(PYTHON, 'utf8').replace(/\r\n/g, '\n')

/**
 * Read a `"""..."""` constant as Python would.
 *
 * The only Python-ism that matters here is the backslash line continuation the
 * prompt uses to wrap long lines without putting newlines in the string.
 */
const pythonText = (name: string): string => {
  const match = new RegExp(`^${name} = """\\\\?\\n([\\s\\S]*?)"""`, 'm').exec(source)
  if (!match) throw new Error(`could not find ${name} in classifier.py`)
  return match[1].replace(/\\\n/g, '').replace(/\\$/, '')
}

const pythonValue = (name: string): string => {
  const match = new RegExp(`^${name} = "([^"]*)"`, 'm').exec(source)
  if (!match) throw new Error(`could not find ${name} in classifier.py`)
  return match[1]
}

const pythonNumber = (name: string): number => {
  const match = new RegExp(`^${name} = ([0-9_.]+)`, 'm').exec(source)
  if (!match) throw new Error(`could not find ${name} in classifier.py`)
  return Number(match[1].replace(/_/g, ''))
}

describe('the browser classifier asks the Python classifier’s question', () => {
  it('finds the Python constants at all', () => {
    // If the extraction silently stopped matching, every assertion below would
    // pass vacuously against an empty string.
    expect(pythonText('SYSTEM_PROMPT').length).toBeGreaterThan(500)
    expect(pythonText('USER_TEMPLATE')).toContain('<prompt>')
  })

  it('uses a byte-identical system prompt', () => {
    expect(SYSTEM_PROMPT).toBe(pythonText('SYSTEM_PROMPT'))
  })

  it('wraps the prompt identically', () => {
    const template = pythonText('USER_TEMPLATE')

    expect(renderUserMessage('do a thing')).toBe(
      template.replace('{prompt}', 'do a thing'),
    )
  })

  it('reports the same prompt version, so a label traces to its wording', () => {
    expect(PROMPT_VERSION).toBe(pythonValue('PROMPT_VERSION'))
  })

  it('uses the same models and escalation threshold', () => {
    expect(BASE_MODEL).toBe(pythonValue('BASE_MODEL'))
    expect(ESCALATION_MODEL).toBe(pythonValue('ESCALATION_MODEL'))
    expect(DEFAULT_THRESHOLD).toBe(pythonNumber('DEFAULT_THRESHOLD'))
  })

  it('truncates prompts at the same length', () => {
    expect(MAX_PROMPT_CHARS).toBe(pythonNumber('MAX_PROMPT_CHARS'))
  })
})
