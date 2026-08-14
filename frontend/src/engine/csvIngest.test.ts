/**
 * CSV ingestion tests.
 *
 * The cases that earn their keep are the double-counting ones. Cached tokens can
 * be counted twice by mapping OpenAI's `prompt_tokens` alongside a cache-read
 * column, and cache writes can be counted twice by using an aggregate column and
 * a split one together. Both produce a total that is plausibly wrong rather than
 * obviously broken, which is the hardest kind of error to notice.
 */

import { describe, expect, it } from 'vitest'

import {
  CANONICAL_HEADER,
  MAPPABLE_FIELDS,
  detectColumns,
  ingestCsv,
  parseTimestamp,
} from './csvIngest'
import { formatMoney, parseMoney, sum } from './money'
import { defaultTable } from './pricing'

const ANTHROPIC = [
  'model,timestamp,input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens',
  'claude-haiku-4-5,2026-09-01T00:00:00Z,100,50,1000,200',
].join('\n')

const OPENAI = [
  'model,created_at,prompt_tokens,completion_tokens,cached_tokens,request_id',
  'gpt-4o,2026-09-01T00:00:00Z,1000,50,800,req-1',
].join('\n')

describe('column detection', () => {
  it('maps an Anthropic-shaped header', () => {
    const mapping = detectColumns([
      'model',
      'timestamp',
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
    ])
    expect(mapping.model).toBe(0)
    expect(mapping.timestamp).toBe(1)
    expect(mapping.input_tokens).toBe(2)
    expect(mapping.output_tokens).toBe(3)
    expect(mapping.cache_read).toBe(4)
    expect(mapping.cache_write).toBe(5)
    // Anthropic's input_tokens is already exclusive of cache reads.
    expect(mapping.inputIncludesCache).toBe(false)
  })

  it('flags an OpenAI-shaped header as cache-inclusive', () => {
    const mapping = detectColumns([
      'model',
      'created_at',
      'prompt_tokens',
      'completion_tokens',
      'cached_tokens',
    ])
    expect(mapping.input_tokens).toBe(2)
    expect(mapping.cache_read).toBe(4)
    expect(mapping.inputIncludesCache).toBe(true)
  })

  it('does not flag prompt_tokens when there is nothing to subtract', () => {
    const mapping = detectColumns(['model', 'prompt_tokens', 'completion_tokens'])
    expect(mapping.inputIncludesCache).toBe(false)
  })

  it('drops the aggregate cache column when split TTL columns exist', () => {
    const mapping = detectColumns([
      'model',
      'cache_creation_input_tokens',
      'ephemeral_1h_input_tokens',
      'ephemeral_5m_input_tokens',
    ])
    expect(mapping.cache_write_1h).toBe(2)
    expect(mapping.cache_write_5m).toBe(3)
    expect(mapping.cache_write).toBeNull()
  })

  it('is case and punctuation insensitive', () => {
    const mapping = detectColumns(['Model Name', 'Input Tokens', 'Output-Tokens'])
    expect(mapping.model).toBe(0)
    expect(mapping.input_tokens).toBe(1)
    expect(mapping.output_tokens).toBe(2)
  })

  it('claims each column at most once', () => {
    const mapping = detectColumns(['model', 'model_id'])
    expect(mapping.model).toBe(0)
  })

  it('leaves unrecognized columns unmapped', () => {
    const mapping = detectColumns(['model', 'latency_ms', 'status'])
    expect(mapping.model).toBe(0)
    expect(mapping.prompt).toBeNull()
  })
})

describe('token semantics', () => {
  it('subtracts cached tokens from a cache-inclusive input column', () => {
    // 1000 prompt tokens of which 800 were cached is 200 uncached, not 1000.
    const { turns } = ingestCsv(OPENAI)
    const call = turns[0].calls[0]
    expect(call.input_tokens).toBe(200)
    expect(call.cache_read).toBe(800)
  })

  it('leaves an exclusive input column alone', () => {
    const { turns } = ingestCsv(ANTHROPIC)
    const call = turns[0].calls[0]
    expect(call.input_tokens).toBe(100)
    expect(call.cache_read).toBe(1000)
  })

  it('reports rather than hides an input count below its cache read', () => {
    const csv = [
      'model,prompt_tokens,cached_tokens',
      'gpt-4o,100,800', // cached exceeds the total it is supposedly part of
    ].join('\n')
    const result = ingestCsv(csv)
    expect(result.turns[0].calls[0].input_tokens).toBe(0)
    expect(result.issues[0].reason).toMatch(/may not include cached tokens/)
  })

  it('attributes an unknown-TTL cache write to the cheaper 5m tier', () => {
    // An unknown TTL must never inflate a reported figure.
    const { turns } = ingestCsv(ANTHROPIC)
    const call = turns[0].calls[0]
    expect(call.cache_write_5m).toBe(200)
    expect(call.cache_write_1h).toBe(0)
  })

  it('ignores an aggregate cache column when split columns are present', () => {
    const csv = [
      'model,cache_creation_input_tokens,ephemeral_1h_input_tokens,ephemeral_5m_input_tokens',
      'claude-opus-5,900,600,300',
    ].join('\n')
    const call = ingestCsv(csv).turns[0].calls[0]
    // 600 + 300, not 600 + 300 + 900.
    expect(call.cache_write_1h).toBe(600)
    expect(call.cache_write_5m).toBe(300)
  })

  it('ignores an aggregate column when a hand-edited mapping keeps both', () => {
    // Detection already drops the aggregate, so this guard only ever fires for a
    // mapping a user confirmed by hand — which is exactly when it matters, and
    // is unreachable through `detectColumns`.
    const csv = [
      'model,agg,one_hour',
      'claude-opus-5,900,600',
    ].join('\n')
    const mapping = {
      ...detectColumns(['model', 'agg', 'one_hour']),
      cache_write: 1,
      cache_write_1h: 2,
    }
    const call = ingestCsv(csv, { mapping }).turns[0].calls[0]
    expect(call.cache_write_1h).toBe(600)
    expect(call.cache_write_5m).toBe(0)
  })

  it('uses an aggregate column when a hand-edited mapping has no split', () => {
    const csv = 'model,agg\nclaude-opus-5,900'
    const mapping = { ...detectColumns(['model', 'agg']), cache_write: 1 }
    const call = ingestCsv(csv, { mapping }).turns[0].calls[0]
    expect(call.cache_write_5m).toBe(900)
  })

  it('reads thousands separators', () => {
    const csv = 'model,input_tokens\nclaude-opus-5,"1,234,567"'
    expect(ingestCsv(csv).turns[0].calls[0].input_tokens).toBe(1_234_567)
  })

  it('treats a blank count as zero', () => {
    const csv = 'model,input_tokens,output_tokens\nclaude-opus-5,,42'
    const call = ingestCsv(csv).turns[0].calls[0]
    expect(call.input_tokens).toBe(0)
    expect(call.output_tokens).toBe(42)
  })

  it('counts an unreadable number as zero and says so', () => {
    const csv = 'model,input_tokens\nclaude-opus-5,lots'
    const result = ingestCsv(csv)
    expect(result.turns[0].calls[0].input_tokens).toBe(0)
    expect(result.issues[0]).toMatchObject({ line: 2 })
    expect(result.issues[0].reason).toMatch(/not a number/)
  })
})

describe('timestamps', () => {
  it('reads ISO 8601', () => {
    expect(parseTimestamp('2026-09-01T00:00:00Z')?.toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    )
  })

  it('reads epoch seconds', () => {
    expect(parseTimestamp('1788220800')?.toISOString()).toBe('2026-09-01T00:00:00.000Z')
  })

  it('reads epoch milliseconds', () => {
    expect(parseTimestamp('1788220800000')?.toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    )
  })

  it('returns null for missing or unreadable values', () => {
    expect(parseTimestamp('')).toBeNull()
    expect(parseTimestamp('   ')).toBeNull()
    expect(parseTimestamp('not a date')).toBeNull()
  })

  it('counts missing timestamps so the promo assumption stays visible', () => {
    // With no date the pricer applies list rates, which changes what a Sonnet
    // row costs inside the introductory window.
    const csv = 'model,timestamp\nclaude-sonnet-5,\nclaude-sonnet-5,2026-07-26T00:00:00Z'
    const result = ingestCsv(csv)
    expect(result.stats.missingTimestamps).toBe(1)
    expect(result.turns[0].calls[0].timestamp).toBeNull()
  })
})

describe('rows and grouping', () => {
  it('gives each row its own turn when there is no turn id', () => {
    const csv = 'model\nclaude-opus-5\nclaude-haiku-4-5'
    const result = ingestCsv(csv)
    expect(result.turns).toHaveLength(2)
    expect(result.profile).toBe('simple')
  })

  it('groups calls under a shared turn id', () => {
    const csv = [
      'model,trace_id,prompt',
      'claude-opus-5,t1,fix the parser',
      'claude-opus-5,t1,',
      'claude-haiku-4-5,t2,rename a file',
    ].join('\n')
    const result = ingestCsv(csv)
    expect(result.turns).toHaveLength(2)
    expect(result.turns[0].calls).toHaveLength(2)
    expect(result.turns[0].prompt_text).toBe('fix the parser')
    expect(result.profile).toBe('agentic')
  })

  it('does not merge rows that simply have no turn id', () => {
    // Two unrelated calls sharing an empty id are not one turn.
    const csv = 'model,trace_id\nclaude-opus-5,\nclaude-haiku-4-5,'
    expect(ingestCsv(csv).turns).toHaveLength(2)
  })

  it('takes the earliest call time as the turn time', () => {
    const csv = [
      'model,trace_id,timestamp',
      'claude-opus-5,t1,2026-09-01T10:00:00Z',
      'claude-opus-5,t1,2026-09-01T09:00:00Z',
    ].join('\n')
    expect(ingestCsv(csv).turns[0].timestamp?.toISOString()).toBe(
      '2026-09-01T09:00:00.000Z',
    )
  })

  it('carries session and user through', () => {
    const csv = 'model,session_id,user_id\nclaude-opus-5,s1,u1'
    const turn = ingestCsv(csv).turns[0]
    expect(turn.session_id).toBe('s1')
    expect(turn.user_id).toBe('u1')
  })

  it('skips a row with no model and reports it', () => {
    // A model is the one thing a call cannot be priced without.
    const csv = 'model,input_tokens\n,100\nclaude-opus-5,200'
    const result = ingestCsv(csv)
    expect(result.stats.skipped).toBe(1)
    expect(result.turns).toHaveLength(1)
    expect(result.issues[0].reason).toMatch(/no model/)
  })

  it('throws when there is no model column at all', () => {
    expect(() => ingestCsv('input_tokens,output_tokens\n1,2')).toThrow(/model column/)
  })

  it('deduplicates on request id and counts what it removed', () => {
    const csv = [
      'model,request_id',
      'claude-opus-5,req-1',
      'claude-opus-5,req-1',
      'claude-opus-5,req-2',
    ].join('\n')
    const result = ingestCsv(csv)
    expect(result.stats.calls).toBe(2)
    expect(result.stats.duplicates).toBe(1)
  })

  it('does not deduplicate rows with a blank request id', () => {
    const csv = 'model,request_id\nclaude-opus-5,\nclaude-opus-5,'
    expect(ingestCsv(csv).stats.calls).toBe(2)
  })

  it('caps the issue list without capping the counts', () => {
    const rows = Array.from({ length: 150 }, () => ',100').join('\n')
    const result = ingestCsv(`model,input_tokens\n${rows}`)
    expect(result.stats.skipped).toBe(150)
    expect(result.issues).toHaveLength(100)
  })
})

describe('reporting', () => {
  it('names models the rate table cannot price', () => {
    const csv = 'model\nclaude-opus-5\nllama-3-70b\nmystery-model'
    const result = ingestCsv(csv)
    expect(result.unknownModels).toEqual(['llama-3-70b', 'mystery-model'])
  })

  it('resolves a prefix fallback rather than calling it unknown', () => {
    expect(ingestCsv('model\nclaude-opus-9-9').unknownModels).toEqual([])
  })

  it('lists columns nothing claimed', () => {
    const csv = 'model,latency_ms,status\nclaude-opus-5,120,200'
    expect(ingestCsv(csv).unmappedColumns).toEqual(['latency_ms', 'status'])
  })

  it('reports row counts', () => {
    const result = ingestCsv(ANTHROPIC)
    expect(result.stats).toMatchObject({ dataRows: 1, calls: 1, turns: 1, skipped: 0 })
  })
})

describe('end to end', () => {
  it('prices an ingested file', () => {
    // Hand-checkable: Haiku input is $1.00/M, so 1,000,000 tokens is exactly
    // $1.00, and output at $5.00/M makes 200,000 tokens exactly $1.00.
    const csv = [
      'model,timestamp,input_tokens,output_tokens',
      'claude-haiku-4-5,2026-09-01T00:00:00Z,1000000,200000',
    ].join('\n')
    const { turns } = ingestCsv(csv)
    const table = defaultTable()
    const total = sum(turns.flatMap((turn) => turn.calls.map((c) => table.costOf(c))))
    expect(total).toBe(parseMoney('2.00'))
    expect(formatMoney(total)).toBe('2')
  })

  it('survives a messy realistic export', () => {
    const csv = [
      '﻿Model,Created At,Input Tokens,Output Tokens,Cache Read Input Tokens,Cache Creation Input Tokens,Trace Id,Prompt,Request Id',
      '"claude-opus-5",2026-09-01T00:00:00Z,"2","286","34,488","12,359",t1,"fix the CSV parser, please",r1',
      '"claude-opus-5",2026-09-01T00:00:10Z,0,120,34488,0,t1,"",r2',
      '"claude-opus-5",2026-09-01T00:00:10Z,0,120,34488,0,t1,"",r2',
      '"claude-haiku-4-5",2026-09-01T00:01:00Z,10,20,0,0,t2,"what does this do?",r3',
    ].join('\r\n')

    const result = ingestCsv(csv)
    expect(result.stats).toMatchObject({
      dataRows: 4,
      calls: 3,
      turns: 2,
      duplicates: 1,
      skipped: 0,
    })
    expect(result.profile).toBe('agentic')
    expect(result.turns[0].prompt_text).toBe('fix the CSV parser, please')
    expect(result.turns[0].calls[0].cache_write_5m).toBe(12_359)
    expect(result.unknownModels).toEqual([])
    expect(result.issues).toEqual([])
  })
})

describe('CANONICAL_HEADER', () => {
  it('is fully auto-detected, so a generated file needs no manual mapping', () => {
    // The conversion prompt on the upload screen tells people to ask for these
    // exact names. If a rename here stopped resolving, they would land in the
    // column mapper with nothing on screen explaining why.
    const mapping = detectColumns([...CANONICAL_HEADER])
    const unmapped = CANONICAL_HEADER.filter(
      (_name, index) => !MAPPABLE_FIELDS.some((field) => mapping[field.field] === index),
    )

    expect(unmapped).toEqual([])
  })

  it('carries the one column without which nothing can be priced', () => {
    expect(CANONICAL_HEADER).toContain('model')
    expect(detectColumns([...CANONICAL_HEADER]).model).not.toBeNull()
  })

  it('keeps input tokens and cache reads apart', () => {
    // Folding them together is the double-count that inflates agentic spend.
    // Asking for both separately is what lets the reader keep them distinct.
    expect(CANONICAL_HEADER).toContain('input_tokens')
    expect(CANONICAL_HEADER).toContain('cache_read')
  })
})
