/**
 * CSV ingestion — arbitrary provider exports into `Turn[]`.
 *
 * This is the layer that decides what a column *means*, which is where the real
 * hazards are. Three of them shaped the code:
 *
 * 1. `prompt_tokens` and `input_tokens` are not the same quantity. Anthropic's
 *    `input_tokens` excludes cache reads; OpenAI's `prompt_tokens` includes its
 *    cached tokens. Mapping both to the same field and also mapping a cache-read
 *    column double-counts every cached token — the same class of error that
 *    already produced a 100/100 score where 80 was expected. `inputIncludesCache`
 *    exists to subtract it, and it is surfaced in the result so the UI can show
 *    the assumption rather than bury it.
 * 2. An export may report cache writes as one aggregate or split by TTL. When
 *    the TTL is unknown the tokens are attributed to the 5-minute tier, the
 *    cheaper of the two, so an unknown never inflates a reported figure — the
 *    same call `ingest/claude_code.py` makes. When both forms are present the
 *    aggregate is ignored, because adding it would count those tokens twice.
 * 3. Detection is a *suggestion*. Header names are not a standard, so the
 *    mapping is returned for the user to confirm and can be overridden wholesale
 *    rather than being applied silently.
 *
 * Rows that cannot be read are reported, never dropped in silence: a row is real
 * spend, and losing it understates the total with no visible symptom.
 */

import { parseCsv } from './csv'
import type { ParsedCsv } from './csv'
import { makeCall } from './models'
import type { Call, Profile, Turn } from './models'
import { defaultTable } from './pricing'

/** Fields a column can be mapped to. */
export type MappableField =
  | 'model'
  | 'timestamp'
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_read'
  | 'cache_write_5m'
  | 'cache_write_1h'
  | 'cache_write'
  | 'prompt'
  | 'turn_id'
  | 'request_id'
  | 'session_id'
  | 'user_id'

export type ColumnMapping = Record<MappableField, number | null> & {
  /**
   * Whether the input column already counts cached tokens (OpenAI's
   * `prompt_tokens`), in which case cache reads are subtracted out.
   */
  inputIncludesCache: boolean
}

export interface RowIssue {
  /** Spreadsheet line number, counting the header as line 1. */
  line: number
  reason: string
}

export interface IngestStats {
  dataRows: number
  calls: number
  turns: number
  skipped: number
  duplicates: number
  missingTimestamps: number
}

export interface CsvIngestResult {
  turns: Turn[]
  mapping: ColumnMapping
  profile: Profile
  stats: IngestStats
  /** Capped at `ISSUE_LIMIT`; `stats.skipped` remains a full count. */
  issues: RowIssue[]
  /** Header names no column mapping claimed. Harmless, but worth showing. */
  unmappedColumns: string[]
  /** Models with no rate entry — costing these would throw. */
  unknownModels: string[]
}

/** Enough to diagnose a bad file without building a list as long as the file. */
export const ISSUE_LIMIT = 100

/** Field order and labels for a mapping UI. Order is the order of detection. */
export const MAPPABLE_FIELDS: {
  field: MappableField
  label: string
  required: boolean
}[] = [
  { field: 'cache_write_5m', label: 'Cache write (5m TTL)', required: false },
  { field: 'cache_write_1h', label: 'Cache write (1h TTL)', required: false },
  { field: 'cache_read', label: 'Cache read', required: false },
  { field: 'cache_write', label: 'Cache write (TTL unknown)', required: false },
  { field: 'input_tokens', label: 'Input tokens', required: false },
  { field: 'output_tokens', label: 'Output tokens', required: false },
  { field: 'model', label: 'Model', required: true },
  { field: 'timestamp', label: 'Timestamp', required: false },
  { field: 'prompt', label: 'Prompt text', required: false },
  { field: 'turn_id', label: 'Turn / trace id', required: false },
  { field: 'request_id', label: 'Request id', required: false },
  { field: 'session_id', label: 'Session id', required: false },
  { field: 'user_id', label: 'User id', required: false },
]

/**
 * Header spellings seen across Helicone, OpenRouter, Claude Console, OpenAI and
 * hand-rolled exports. Matched on an exact normalized name rather than by
 * substring, so `cache_creation_input_tokens` cannot be mistaken for
 * `cache_creation_input_tokens_5m`; anything unrecognized is left for the user
 * to map.
 */
const CANDIDATES: Record<MappableField, string[]> = {
  cache_write_5m: [
    'cachewrite5m',
    'cachecreation5m',
    'ephemeral5minputtokens',
    'cachecreationinputtokens5m',
    'cache5mtokens',
  ],
  cache_write_1h: [
    'cachewrite1h',
    'cachecreation1h',
    'ephemeral1hinputtokens',
    'cachecreationinputtokens1h',
    'cache1htokens',
  ],
  cache_read: [
    'cacheread',
    'cachereadtokens',
    'cachereadinputtokens',
    'cachedtokens',
    'cachedinputtokens',
    'promptcachedtokens',
    'prompttokensdetailscachedtokens',
  ],
  cache_write: [
    'cachewrite',
    'cachewritetokens',
    'cachecreationtokens',
    'cachecreationinputtokens',
  ],
  input_tokens: [
    'inputtokens',
    'uncachedinputtokens',
    'prompttokens',
    'prompttokenscount',
    'inputtokencount',
    'tokensin',
    'tokensprompt',
  ],
  output_tokens: [
    'outputtokens',
    'completiontokens',
    'outputtokencount',
    'tokensout',
    'tokenscompletion',
  ],
  model: ['model', 'modelname', 'modelid', 'requestmodel', 'modelused', 'engine'],
  timestamp: [
    'timestamp',
    'createdat',
    'requestcreatedat',
    'datetime',
    'requesttime',
    'starttime',
    'created',
    'date',
    'time',
  ],
  prompt: [
    'prompt',
    'prompttext',
    'userprompt',
    'usermessage',
    'requestbody',
    'question',
    'content',
    'text',
  ],
  turn_id: ['turnid', 'traceid', 'conversationid', 'threadid', 'promptid', 'groupid'],
  request_id: ['requestid', 'messageid', 'callid', 'generationid', 'id'],
  session_id: ['sessionid', 'session'],
  user_id: ['userid', 'user', 'enduserid'],
}

/**
 * Input spellings that already include cached tokens in their count.
 *
 * OpenAI reports `prompt_tokens` as the whole prompt with
 * `prompt_tokens_details.cached_tokens` as a *subset*; Anthropic reports
 * `input_tokens` as uncached only, with cache reads alongside it. The
 * distinction decides whether cache reads get counted once or twice.
 */
const CACHE_INCLUSIVE_INPUT = new Set([
  'prompttokens',
  'prompttokenscount',
  'tokensprompt',
])

const normalize = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/g, '')

const emptyMapping = (): ColumnMapping => ({
  model: null,
  timestamp: null,
  input_tokens: null,
  output_tokens: null,
  cache_read: null,
  cache_write_5m: null,
  cache_write_1h: null,
  cache_write: null,
  prompt: null,
  turn_id: null,
  request_id: null,
  session_id: null,
  user_id: null,
  inputIncludesCache: false,
})

/**
 * Suggest a column mapping for a header row.
 *
 * Exported so a mapping UI can show its guesses before anything is parsed. Each
 * column is claimed at most once, and fields are resolved in `MAPPABLE_FIELDS`
 * order — most specific first, so a file carrying both split and aggregate cache
 * columns binds the split ones and leaves the aggregate unclaimed.
 */
export const detectColumns = (header: string[]): ColumnMapping => {
  const byName = new Map<string, number>()
  header.forEach((name, index) => {
    const key = normalize(name)
    // First occurrence wins; a duplicated header name is not a reason to prefer
    // the later column.
    if (key && !byName.has(key)) byName.set(key, index)
  })

  const mapping = emptyMapping()
  const claimed = new Set<number>()

  for (const { field } of MAPPABLE_FIELDS) {
    for (const candidate of CANDIDATES[field]) {
      const index = byName.get(candidate)
      if (index === undefined || claimed.has(index)) continue
      mapping[field] = index
      claimed.add(index)
      if (field === 'input_tokens' && CACHE_INCLUSIVE_INPUT.has(candidate)) {
        mapping.inputIncludesCache = true
      }
      break
    }
  }

  // The subtraction only applies when there is a cache-read column to subtract.
  if (mapping.cache_read === null) mapping.inputIncludesCache = false

  // An aggregate cache-write column alongside split ones would double-count.
  if (mapping.cache_write_5m !== null || mapping.cache_write_1h !== null) {
    mapping.cache_write = null
  }

  return mapping
}

/**
 * Read an integer token count.
 *
 * Returns null when the text is present but unreadable, so the caller can report
 * it. Blank means zero: exports routinely leave a category empty rather than
 * writing 0, and treating that as an error would reject most real files.
 */
const toInt = (raw: string | undefined): number | null => {
  const text = (raw ?? '').trim()
  if (!text || text === '-') return 0
  // Thousands separators and stray spaces are common in spreadsheet-touched files.
  const cleaned = text.replace(/[\s,_]/g, '')
  const value = Number(cleaned)
  if (!Number.isFinite(value)) return null
  // A fractional token count is meaningless; "1234.0" is the realistic case.
  return Math.round(value)
}

/**
 * Read a timestamp.
 *
 * Accepts ISO 8601, epoch seconds, and epoch milliseconds. Returns null when
 * absent or unreadable — the cost engine then prices at list rates, which is the
 * correct conservative answer, since assuming a promotional window we cannot
 * date would understate real spend.
 */
export const parseTimestamp = (raw: string | undefined): Date | null => {
  const text = (raw ?? '').trim()
  if (!text) return null

  if (/^\d+$/.test(text)) {
    const digits = Number(text)
    // Seconds vs milliseconds by magnitude: 1e12 sits in 2001 as milliseconds
    // and in the year 33658 as seconds, so the split is unambiguous in practice.
    const millis = text.length >= 12 ? digits : digits * 1000
    const fromEpoch = new Date(millis)
    return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch
  }

  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const cell = (row: string[], index: number | null): string | undefined =>
  index === null ? undefined : row[index]

export interface IngestOptions {
  /** Replaces detection wholesale — what a confirmed mapping UI passes back. */
  mapping?: ColumnMapping
  delimiter?: string
}

/** Parse CSV text into turns, with a report of everything that was ambiguous. */
export const ingestCsv = (text: string, options: IngestOptions = {}): CsvIngestResult =>
  ingestParsed(parseCsv(text, options.delimiter), options.mapping)

/**
 * Ingest an already-tokenized file.
 *
 * Split out because a mapping UI has to show the header and a few sample rows
 * before the mapping is confirmed, and re-reading the whole file on confirm
 * would parse everything twice for no gain.
 */
export const ingestParsed = (
  parsed: ParsedCsv,
  suppliedMapping?: ColumnMapping,
): CsvIngestResult => {
  const mapping = suppliedMapping ?? detectColumns(parsed.header)

  if (mapping.model === null) {
    throw new Error(
      'no model column found; a model is required to price a call. ' +
        `Columns present: ${parsed.header.join(', ')}`,
    )
  }

  const issues: RowIssue[] = []
  const note = (line: number, reason: string) => {
    if (issues.length < ISSUE_LIMIT) issues.push({ line, reason })
  }

  const seenRequests = new Set<string>()
  const order: string[] = []
  const grouped = new Map<
    string,
    { calls: Call[]; prompt: string | null; session: string | null; user: string | null }
  >()

  let skipped = 0
  let duplicates = 0
  let missingTimestamps = 0
  let calls = 0

  // Split cache columns win over an aggregate; using both counts those tokens
  // twice. Detection already enforces this, but a hand-edited mapping can not.
  const useAggregateCacheWrite =
    mapping.cache_write !== null &&
    mapping.cache_write_5m === null &&
    mapping.cache_write_1h === null

  parsed.rows.forEach((row, index) => {
    const line = index + 2 // header is line 1

    if (row.length !== parsed.header.length) {
      note(line, `has ${row.length} fields against ${parsed.header.length} columns`)
    }

    const model = (cell(row, mapping.model) ?? '').trim()
    if (!model) {
      skipped += 1
      note(line, 'no model; row skipped')
      return
    }

    const requestId = (cell(row, mapping.request_id) ?? '').trim()
    if (requestId) {
      if (seenRequests.has(requestId)) {
        duplicates += 1
        return
      }
      seenRequests.add(requestId)
    }

    const read = (field: MappableField): number => {
      const value = toInt(cell(row, mapping[field]))
      if (value === null) {
        note(line, `${field} is not a number; counted as 0`)
        return 0
      }
      return value
    }

    const cacheRead = read('cache_read')
    let inputTokens = read('input_tokens')

    if (mapping.inputIncludesCache) {
      if (inputTokens < cacheRead) {
        note(
          line,
          `input (${inputTokens}) is below cache read (${cacheRead}); ` +
            'the input column may not include cached tokens after all',
        )
        inputTokens = 0
      } else {
        inputTokens -= cacheRead
      }
    }

    let write5m = read('cache_write_5m')
    const write1h = read('cache_write_1h')
    if (useAggregateCacheWrite) {
      write5m += read('cache_write')
    }

    const timestamp = parseTimestamp(cell(row, mapping.timestamp))
    if (timestamp === null) missingTimestamps += 1

    const call = makeCall({
      model,
      timestamp,
      input_tokens: inputTokens,
      output_tokens: read('output_tokens'),
      cache_read: cacheRead,
      cache_write_5m: write5m,
      cache_write_1h: write1h,
    })
    calls += 1

    // An empty turn id groups nothing: unrelated rows must not be merged into
    // one turn just because neither carried an id. This differs from the JSONL
    // adapter, where unattributed calls provably belong to the same session.
    const turnId = (cell(row, mapping.turn_id) ?? '').trim() || `row:${line}`
    const prompt = (cell(row, mapping.prompt) ?? '').trim() || null

    let group = grouped.get(turnId)
    if (!group) {
      group = { calls: [], prompt: null, session: null, user: null }
      grouped.set(turnId, group)
      order.push(turnId)
    }
    group.calls.push(call)
    // First non-empty value wins: later calls in an agentic turn repeat the same
    // session and user, and tool-result rows often leave the prompt blank.
    group.prompt ??= prompt
    group.session ??= (cell(row, mapping.session_id) ?? '').trim() || null
    group.user ??= (cell(row, mapping.user_id) ?? '').trim() || null
  })

  // A file whose rows never share a turn id is single-shot data, whatever
  // columns it happened to carry.
  const profile: Profile = [...grouped.values()].some((g) => g.calls.length > 1)
    ? 'agentic'
    : 'simple'

  const turns: Turn[] = order.map((turnId) => {
    const group = grouped.get(turnId)!
    const times = group.calls
      .map((call) => call.timestamp)
      .filter((value): value is Date => value !== null)
    return {
      turn_id: turnId,
      profile,
      timestamp: times.length
        ? new Date(Math.min(...times.map((value) => value.getTime())))
        : null,
      calls: group.calls,
      prompt_text: group.prompt,
      session_id: group.session,
      user_id: group.user,
    }
  })

  const claimed = new Set(
    MAPPABLE_FIELDS.map(({ field }) => mapping[field]).filter(
      (index): index is number => index !== null,
    ),
  )

  return {
    turns,
    mapping,
    profile,
    stats: {
      dataRows: parsed.rows.length,
      calls,
      turns: turns.length,
      skipped,
      duplicates,
      missingTimestamps,
    },
    issues,
    unmappedColumns: parsed.header.filter((_, index) => !claimed.has(index)),
    unknownModels: findUnknownModels(turns),
  }
}

/**
 * Models the rate table cannot price.
 *
 * Checked at ingest so the UI can name them while the file is still in hand.
 * The pricer raises on an unknown model deliberately, and a stack trace three
 * screens later is a much worse way to learn that an export used a model id the
 * table has never seen.
 */
const findUnknownModels = (turns: Turn[]): string[] => {
  const table = defaultTable()
  const unknown = new Set<string>()
  const checked = new Set<string>()

  for (const turn of turns) {
    for (const call of turn.calls) {
      if (checked.has(call.model)) continue
      checked.add(call.model)
      try {
        table.resolve(call.model)
      } catch {
        unknown.add(call.model)
      }
    }
  }
  return [...unknown]
}
