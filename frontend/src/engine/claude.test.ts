/**
 * Claude adapter tests.
 *
 * No network and no key: `send` is injected, which also lets these assert the
 * two things about the *request* that are easy to get wrong and impossible to
 * notice from the answer — that Haiku is not sent parameters it rejects, and
 * that Sonnet is told not to think.
 */

import { describe, expect, it, vi } from 'vitest'

import type Anthropic from '@anthropic-ai/sdk'

import { BASE_MODEL, ESCALATION_MODEL, createClaudeBackend } from './claude'
import type { Send } from './claude'
import { ClassificationError, SYSTEM_PROMPT, renderUserMessage } from './classifier'
import { formatMoney } from './money'

const answer = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    category: 'coding',
    complexity: 'complex',
    confidence: 0.9,
    rationale: 'multi-file refactor',
    ...overrides,
  })

/** A reply in the shape the SDK returns; only the read fields need be real. */
const reply = (
  text: string,
  stop_reason: Anthropic.Message['stop_reason'] = 'end_turn',
): Anthropic.Message =>
  ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: BASE_MODEL,
    content: text ? [{ type: 'text', text, citations: null }] : [],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 500, output_tokens: 80 },
  }) as unknown as Anthropic.Message

/** Scripts one reply per model and records every request made. */
const sender = (byModel: Record<string, Anthropic.Message>) => {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = []
  const send: Send = async (params) => {
    calls.push(params)
    const scripted = byModel[params.model]
    if (!scripted) throw new Error(`no reply scripted for ${params.model}`)
    return scripted
  }
  return { send, calls }
}

const never = new AbortController().signal

describe('escalation', () => {
  it('keeps the Haiku answer when it is confident', async () => {
    const { send, calls } = sender({ [BASE_MODEL]: reply(answer({ confidence: 0.9 })) })
    const backend = createClaudeBackend('sk-test', { send })

    const found = await backend.classify('port the engine', never)

    expect(calls.map((c) => c.model)).toEqual([BASE_MODEL])
    expect(found).toMatchObject({
      category: 'coding',
      complexity: 'complex',
      model: BASE_MODEL,
    })
    expect(found.escalated).toBeUndefined()
  })

  it('escalates below the threshold and lets Sonnet win', async () => {
    const { send, calls } = sender({
      [BASE_MODEL]: reply(answer({ complexity: 'trivial', confidence: 0.4 })),
      [ESCALATION_MODEL]: reply(answer({ complexity: 'complex', confidence: 0.95 })),
    })
    const backend = createClaudeBackend('sk-test', { send })

    const found = await backend.classify('port the engine', never)

    expect(calls.map((c) => c.model)).toEqual([BASE_MODEL, ESCALATION_MODEL])
    expect(found).toMatchObject({
      complexity: 'complex',
      model: ESCALATION_MODEL,
      escalated: true,
    })
  })

  it('keeps the pre-escalation answer, or the agreement figure means nothing', async () => {
    const { send } = sender({
      [BASE_MODEL]: reply(answer({ complexity: 'trivial', confidence: 0.4 })),
      [ESCALATION_MODEL]: reply(answer({ complexity: 'complex', confidence: 0.95 })),
    })

    const found = await createClaudeBackend('sk-test', { send }).classify('x', never)

    expect(found.base_complexity).toBe('trivial')
    expect(found.base_confidence).toBe(0.4)
    expect(found.base_category).toBe('coding')
  })

  it('treats the threshold as inclusive, matching the Python', async () => {
    const { send, calls } = sender({
      [BASE_MODEL]: reply(answer({ confidence: 0.7 })),
    })

    await createClaudeBackend('sk-test', { send, threshold: 0.7 }).classify('x', never)

    expect(calls).toHaveLength(1)
  })
})

describe('the request', () => {
  const requestTo = async (model: string, confidence: number) => {
    const { send, calls } = sender({
      [BASE_MODEL]: reply(answer({ confidence })),
      [ESCALATION_MODEL]: reply(answer({ confidence: 0.95 })),
    })
    await createClaudeBackend('sk-test', { send }).classify('do a thing', never)
    return calls.find((c) => c.model === model)!
  }

  it('sends Haiku no thinking and no effort, both of which it rejects', async () => {
    const request = await requestTo(BASE_MODEL, 0.9)

    expect(request.thinking).toBeUndefined()
    expect(request.output_config?.effort).toBeUndefined()
  })

  it('tells Sonnet not to think, since adaptive is on by default', async () => {
    // Omitting `thinking` on Sonnet 5 means adaptive thinking — billed thinking
    // tokens and added latency on every escalation, for a four-field answer.
    const request = await requestTo(ESCALATION_MODEL, 0.4)

    expect(request.thinking).toEqual({ type: 'disabled' })
    expect(request.output_config?.effort).toBe('low')
  })

  it('constrains both models to the same schema', async () => {
    const haiku = await requestTo(BASE_MODEL, 0.9)
    const sonnet = await requestTo(ESCALATION_MODEL, 0.4)

    for (const request of [haiku, sonnet]) {
      const schema = request.output_config?.format
      expect(schema?.type).toBe('json_schema')
      expect(schema?.schema).toMatchObject({
        additionalProperties: false,
        required: ['category', 'complexity', 'confidence', 'rationale'],
      })
    }
  })

  it('sends the prompt through unchanged — the runner already truncated it', async () => {
    const request = await requestTo(BASE_MODEL, 0.9)

    expect(request.system).toBe(SYSTEM_PROMPT)
    expect(request.messages).toEqual([
      { role: 'user', content: renderUserMessage('do a thing') },
    ])
  })

  it('passes the abort signal to every request', async () => {
    const controller = new AbortController()
    const send = vi.fn<Send>(async () => reply(answer({ confidence: 0.4 })))

    await createClaudeBackend('sk-test', { send }).classify('x', controller.signal)

    expect(send).toHaveBeenCalledTimes(2)
    for (const call of send.mock.calls) {
      expect(call[1]).toEqual({ signal: controller.signal })
    }
  })
})

describe('unusable replies', () => {
  const failing = (message: Anthropic.Message) =>
    createClaudeBackend('sk-test', {
      send: sender({ [BASE_MODEL]: message }).send,
    }).classify('x', never)

  it('does not parse a refusal as an answer', async () => {
    await expect(failing(reply('', 'refusal'))).rejects.toThrow(/declined/)
  })

  it('does not parse a truncated answer', async () => {
    await expect(failing(reply('{"category": "cod', 'max_tokens'))).rejects.toThrow(
      /token cap/,
    )
  })

  it('reports non-JSON text as such', async () => {
    await expect(failing(reply('I cannot do that.'))).rejects.toThrow(/not JSON/)
  })

  it('reports an empty response', async () => {
    await expect(failing(reply(''))).rejects.toThrow(/no text/)
  })

  it('rejects a well-formed reply with a value outside the schema', async () => {
    // The schema cannot bound confidence — numeric constraints are not in the
    // supported subset — so this is the guard that actually holds the line.
    await expect(failing(reply(answer({ confidence: 4 })))).rejects.toThrow(
      ClassificationError,
    )
  })
})

describe('estimate', () => {
  // Deliberately no key and no `send`: quoting a price must never require
  // either, or the screen cannot show the cost before asking for the key.
  const backend = createClaudeBackend('')

  it('is quoted before anything is spent and says it is approximate', () => {
    const estimate = backend.estimate(['classify me'])

    expect(estimate.approximate).toBe(true)
    expect(Number(formatMoney(estimate.cost!))).toBeGreaterThan(0)
    expect(estimate.note).toMatch(/Haiku 4\.5/)
  })

  it('scales with the number of prompts', () => {
    const one = backend.estimate(['classify me']).cost!
    const ten = backend.estimate(Array(10).fill('classify me')).cost!

    expect(ten).toBe(one * 10n)
  })

  it('costs nothing for nothing', () => {
    expect(backend.estimate([]).cost).toBe(0n)
  })

  it('prices Sonnet at the promotional rate while the window is open', () => {
    // The rate table carries Sonnet 5's introductory pricing to 2026-08-31.
    // Reusing it is what keeps the quote and the published figures on one sheet.
    const table = { promotional: new Date('2026-08-01'), list: new Date('2026-12-01') }
    vi.useFakeTimers()
    try {
      vi.setSystemTime(table.promotional)
      const discounted = backend.estimate(['classify me']).cost!
      vi.setSystemTime(table.list)
      const full = backend.estimate(['classify me']).cost!

      expect(discounted).toBeLessThan(full)
    } finally {
      vi.useRealTimers()
    }
  })
})
