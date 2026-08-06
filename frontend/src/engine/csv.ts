/**
 * RFC 4180 CSV reader.
 *
 * Hand-written rather than pulled from a package: the format is small and fully
 * specified, the app ships no runtime dependency beyond React today, and the
 * awkward parts here are not the tokenizer but the column semantics one layer
 * up in `csvIngest.ts`. The tradeoff is that this reads a whole file into
 * memory, which is fine for an export of a few hundred thousand rows and would
 * need revisiting for something much larger.
 *
 * What real exports do that a naive `split(',')` gets wrong, and this handles:
 * quoted fields containing the delimiter, embedded newlines inside quotes (a
 * prompt column is full of them), doubled quotes as an escape, CRLF endings from
 * Windows tooling, and a UTF-8 BOM from Excel.
 */

/** Delimiters worth guessing between, in preference order for ties. */
const CANDIDATE_DELIMITERS = [',', '\t', ';', '|'] as const

export interface ParsedCsv {
  header: string[]
  /** Data rows, exactly as they appeared — ragged rows are not padded here. */
  rows: string[][]
  delimiter: string
}

export class CsvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CsvError'
  }
}

/**
 * Guess the delimiter from the first line.
 *
 * Counts only separators outside quotes, so a comma inside a quoted prompt does
 * not vote for comma. Ties break toward the earlier candidate, which puts the
 * overwhelmingly common case first.
 */
export const detectDelimiter = (text: string): string => {
  const line = firstRecord(text)
  let best: string = CANDIDATE_DELIMITERS[0]
  let bestCount = 0

  for (const delimiter of CANDIDATE_DELIMITERS) {
    let count = 0
    let inQuotes = false
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i]
      if (char === '"') {
        // A doubled quote is an escaped literal, not a state change.
        if (inQuotes && line[i + 1] === '"') i += 1
        else inQuotes = !inQuotes
      } else if (char === delimiter && !inQuotes) {
        count += 1
      }
    }
    if (count > bestCount) {
      best = delimiter
      bestCount = count
    }
  }
  return best
}

/** The first record's text, respecting newlines inside quoted fields. */
const firstRecord = (text: string): string => {
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') i += 1
      else inQuotes = !inQuotes
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      return text.slice(0, i)
    }
  }
  return text
}

/**
 * Tokenize CSV text into a header and rows.
 *
 * Blank lines are skipped rather than yielded as a one-empty-field row — the
 * same call the JSONL adapter makes, for the same reason: a stray line break
 * should not become a data row.
 *
 * A quote only opens a quoted field at the start of a field. Elsewhere it is a
 * literal character, so `5" pipe` survives instead of swallowing the rest of the
 * file. Being lenient about leading whitespace before a quote was considered and
 * rejected: it would silently alter values that legitimately begin with a space.
 */
export const parseCsv = (input: string, delimiter?: string): ParsedCsv => {
  // Excel writes a BOM; left in place it becomes part of the first header name
  // and every column match against it fails for no visible reason.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input

  if (!text.trim()) {
    throw new CsvError('the file is empty')
  }

  const sep = delimiter ?? detectDelimiter(text)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  const endField = () => {
    row.push(field)
    field = ''
  }

  const endRow = () => {
    endField()
    // Skip a row that is entirely empty; keep one that has any content.
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }

  let i = 0
  while (i < text.length) {
    const char = text[i]

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += char
      i += 1
      continue
    }

    if (char === '"' && field === '') {
      inQuotes = true
      i += 1
      continue
    }

    if (char === sep) {
      endField()
      i += 1
      continue
    }

    if (char === '\n' || char === '\r') {
      endRow()
      i += char === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }

    field += char
    i += 1
  }

  // A file need not end with a newline; flush whatever is still buffered.
  if (field !== '' || row.length > 0) endRow()

  const header = rows.shift()
  if (!header) {
    throw new CsvError('the file has no header row')
  }

  return { header: header.map((name) => name.trim()), rows, delimiter: sep }
}
