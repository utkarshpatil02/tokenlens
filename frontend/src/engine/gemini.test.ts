/**
 * Gemini adapter tests.
 *
 * `fetch` is injected, so these run offline and can assert on the request as
 * well as the answer. The retry block carries most of the weight: on a free tier
 * a 429 is ordinary traffic, and an adapter that passed one through as a failure
 * would trip the runner's breaker three prompts into a long run.
 */

import { describe, expect, it } from 'vitest'

import { ClassificationError, SYSTEM_PROMPT, renderUserMessage } from './classifier'
import {
  BASE_MODEL,
  ESCALATION_MODEL,
  MAX_RETRIES,
  createGeminiBackend,
} from './gemini'
import type { Fetch } from './gemini'

const answer = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    category: 'coding',
    complexity: 'complex',
    confidence: 0.9,
    rationale: 'multi-file refactor',
    ...overrides,
  })

const ok = (text: string, finishReason = 'STOP') =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

const fail = (status: number, message = 'nope', headers: HeadersInit = {}) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers })

/** Scripts replies in order and records every request. */
const scripted = (replies: Response[]) => {
  const urls: string[] = []
  const bodies: Record<string, unknown>[] = []
  const headers: (HeadersInit | undefined)[] = []
  let index = 0
  const fetchImpl = (async (url, init) => {
    urls.push(String(url))
    bodies.push(JSON.parse(String(init?.body)))
    headers.push(init?.headers)
    const reply = replies[index++]
    if (!reply) throw new Error('ran out of scripted replies')
    return reply
  }) as Fetch
  return { fetchImpl, urls, bodies, headers }
}

/** Backoff without the waiting. */
const instant = () => {
  const waited: number[] = []
  return {
    waited,
    wait: async (ms: number) => {
      waited.push(ms)
    },
  }
}

const never = new AbortController().signal

const backend = (replies: Response[], extra = {}) => {
  const net = scripted(replies)
  const timer = instant()
  return {
    ...net,
    ...timer,
    subject: createGeminiBackend('key-123', {
      fetchImpl: net.fetchImpl,
      wait: timer.wait,
      ...extra,
    }),
  }
}

describe('escalation', () => {
  it('keeps the Flash-Lite answer when it is confident', async () => {
    const { subject, urls } = backend([ok(answer({ confidence: 0.9 }))])

    const found = await subject.classify('port the engine', never)

    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain(`${BASE_MODEL}:generateContent`)
    expect(found).toMatchObject({ complexity: 'complex', model: BASE_MODEL })
  })

  it('escalates below the threshold and keeps the first answer alongside', async () => {
    const { subject, urls } = backend([
      ok(answer({ complexity: 'trivial', confidence: 0.4 })),
      ok(answer({ complexity: 'complex', confidence: 0.95 })),
    ])

    const found = await subject.classify('port the engine', never)

    expect(urls[1]).toContain(`${ESCALATION_MODEL}:generateContent`)
    expect(found).toMatchObject({
      complexity: 'complex',
      model: ESCALATION_MODEL,
      escalated: true,
      base_complexity: 'trivial',
      base_confidence: 0.4,
    })
  })
})

describe('the request', () => {
  it('asks the same question as every other provider', async () => {
    const { subject, bodies } = backend([ok(answer())])

    await subject.classify('do a thing', never)

    expect(bodies[0]).toMatchObject({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: renderUserMessage('do a thing') }] }],
    })
  })

  it("uses Gemini's schema dialect, not JSON Schema", async () => {
    const { subject, bodies } = backend([ok(answer())])

    await subject.classify('x', never)

    const config = (bodies[0] as { generationConfig: Record<string, unknown> })
      .generationConfig
    expect(config.responseMimeType).toBe('application/json')
    expect(config.responseSchema).toMatchObject({
      type: 'OBJECT',
      required: ['category', 'complexity', 'confidence', 'rationale'],
      propertyOrdering: ['category', 'complexity', 'confidence', 'rationale'],
    })
  })

  it('sends the key as a header, never in the URL', async () => {
    const { subject, urls, headers } = backend([ok(answer())])

    await subject.classify('x', never)

    // A key in a query string lands in history, logs and referrer headers.
    expect(urls[0]).not.toContain('key-123')
    expect(headers[0]).toMatchObject({ 'x-goog-api-key': 'key-123' })
  })
})

describe('rate limits are traffic, not failure', () => {
  it('retries a 429 and succeeds', async () => {
    const { subject, waited, urls } = backend([
      fail(429, 'quota exceeded'),
      fail(429, 'quota exceeded'),
      ok(answer()),
    ])

    const found = await subject.classify('x', never)

    expect(found.complexity).toBe('complex')
    expect(urls).toHaveLength(3)
    // Doubling, so a burst of limits backs further off each time.
    expect(waited).toEqual([2000, 4000])
  })

  it('prefers the server’s own Retry-After to its guess', async () => {
    const { subject, waited } = backend([
      fail(429, 'slow down', { 'retry-after': '7' }),
      ok(answer()),
    ])

    await subject.classify('x', never)

    expect(waited).toEqual([7000])
  })

  it('retries 500 and 503 too', async () => {
    const { subject, urls } = backend([fail(503), fail(500), ok(answer())])

    await subject.classify('x', never)

    expect(urls).toHaveLength(3)
  })

  it('gives up after the retry budget and reports the last reason', async () => {
    const { subject, urls } = backend(
      Array(MAX_RETRIES + 1).fill(null).map(() => fail(429, 'quota exceeded')),
    )

    await expect(subject.classify('x', never)).rejects.toThrow(/429.*quota exceeded/)
    expect(urls).toHaveLength(MAX_RETRIES + 1)
  })

  it('does not retry a rejected key — that will never come good', async () => {
    const { subject, urls } = backend([fail(400, 'API key not valid')])

    await expect(subject.classify('x', never)).rejects.toThrow(/API key not valid/)
    // One attempt only: retrying a bad key is what the breaker exists to stop.
    expect(urls).toHaveLength(1)
  })

  it('stops waiting when the run is aborted mid-backoff', async () => {
    const controller = new AbortController()
    const subject = createGeminiBackend('key-123', {
      fetchImpl: (async () => fail(429)) as Fetch,
      wait: async (_ms: number, signal: AbortSignal) => {
        controller.abort()
        if (signal.aborted) throw new Error('The operation was aborted')
      },
    })

    await expect(subject.classify('x', controller.signal)).rejects.toThrow(/aborted/)
  })
})

describe('unusable replies', () => {
  const failing = (response: Response) =>
    backend([response]).subject.classify('x', never)

  it('does not parse a blocked prompt as an answer', async () => {
    const blocked = new Response(
      JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }),
      { status: 200 },
    )

    await expect(failing(blocked)).rejects.toThrow(/blocked the prompt \(SAFETY\)/)
  })

  it('does not parse a truncated reply', async () => {
    await expect(failing(ok('{"category": "cod', 'MAX_TOKENS'))).rejects.toThrow(
      /stopped early \(MAX_TOKENS\)/,
    )
  })

  it('reports an empty candidate list', async () => {
    await expect(
      failing(new Response(JSON.stringify({ candidates: [] }), { status: 200 })),
    ).rejects.toThrow(/no candidates/)
  })

  it('reports non-JSON text', async () => {
    await expect(failing(ok('I cannot do that.'))).rejects.toThrow(/not JSON/)
  })

  it('rejects a value the schema could not constrain', async () => {
    await expect(failing(ok(answer({ confidence: 4 })))).rejects.toThrow(
      ClassificationError,
    )
  })
})

describe('estimate', () => {
  it('refuses to quote a price it cannot know', () => {
    const estimate = createGeminiBackend('').estimate(['a', 'b'])

    // Free tier or paid tier is not visible from here, and "$0" would be a
    // claim about someone else's billing account.
    expect(estimate.cost).toBeNull()
    expect(estimate.note).toMatch(/free tier or a paid/i)
  })

  it('needs no key and no network', () => {
    expect(() => createGeminiBackend('').estimate([])).not.toThrow()
  })
})

describe('provider parity', () => {
  it('reports a stable id the dashboard can attribute labels to', () => {
    expect(createGeminiBackend('').id).toBe('gemini')
  })

  it('stamps the model that actually answered', async () => {
    const { subject } = backend([
      ok(answer({ confidence: 0.4 })),
      ok(answer({ confidence: 0.99 })),
    ])

    const found = await subject.classify('x', never)

    // Not the model that was asked first — the one whose answer is being used.
    expect(found.model).toBe(ESCALATION_MODEL)
  })
})
