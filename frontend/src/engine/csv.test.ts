/**
 * CSV reader tests.
 *
 * Weighted toward what real exports actually contain rather than what the RFC
 * makes elegant: prompt columns hold commas and newlines, Excel writes a BOM and
 * CRLF, and a file that arrives with any of those mis-parsed produces a cost
 * figure that is wrong without looking wrong.
 */

import { describe, expect, it } from 'vitest'

import { CsvError, detectDelimiter, parseCsv } from './csv'

describe('basic parsing', () => {
  it('reads a header and rows', () => {
    const { header, rows } = parseCsv('model,tokens\nhaiku,10\nopus,20')
    expect(header).toEqual(['model', 'tokens'])
    expect(rows).toEqual([
      ['haiku', '10'],
      ['opus', '20'],
    ])
  })

  it('trims whitespace from header names but not from values', () => {
    const { header, rows } = parseCsv(' model , tokens \nhaiku , 10 ')
    expect(header).toEqual(['model', 'tokens'])
    expect(rows).toEqual([['haiku ', ' 10 ']])
  })

  it('handles a file with a header and no data rows', () => {
    expect(parseCsv('model,tokens').rows).toEqual([])
  })

  it('keeps empty trailing fields', () => {
    expect(parseCsv('a,b,c\n1,,').rows).toEqual([['1', '', '']])
  })

  it('preserves ragged rows rather than padding them', () => {
    // The ingest layer reports these; silently padding would hide a broken file.
    expect(parseCsv('a,b,c\n1,2').rows).toEqual([['1', '2']])
  })
})

describe('quoting', () => {
  it('keeps a delimiter inside quotes', () => {
    expect(parseCsv('a,b\n"one, two",3').rows).toEqual([['one, two', '3']])
  })

  it('keeps a newline inside quotes', () => {
    // A prompt column is full of these.
    const { rows } = parseCsv('prompt,model\n"line one\nline two",opus')
    expect(rows).toEqual([['line one\nline two', 'opus']])
  })

  it('unescapes a doubled quote', () => {
    expect(parseCsv('a\n"she said ""hi"""').rows).toEqual([['she said "hi"']])
  })

  it('treats a quote inside an unquoted field as literal', () => {
    // `5" pipe` must not swallow the rest of the file.
    expect(parseCsv('a,b\n5" pipe,x').rows).toEqual([['5" pipe', 'x']])
  })

  it('reads an empty quoted field', () => {
    expect(parseCsv('a,b\n"",x').rows).toEqual([['', 'x']])
  })
})

describe('line endings and encoding', () => {
  it('handles CRLF', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4').rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ])
  })

  it('handles a lone CR', () => {
    expect(parseCsv('a,b\r1,2').rows).toEqual([['1', '2']])
  })

  it('strips a UTF-8 BOM', () => {
    // Left in place it becomes part of the first header name and every column
    // match against it fails for no visible reason.
    expect(parseCsv('﻿model,tokens\nhaiku,1').header).toEqual(['model', 'tokens'])
  })

  it('ignores a trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n').rows).toEqual([['1', '2']])
  })

  it('skips blank lines', () => {
    expect(parseCsv('a,b\n1,2\n\n3,4\n\n').rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ])
  })
})

describe('delimiter detection', () => {
  it('detects commas', () => {
    expect(detectDelimiter('a,b,c')).toBe(',')
  })

  it('detects tabs', () => {
    expect(detectDelimiter('a\tb\tc')).toBe('\t')
  })

  it('detects semicolons', () => {
    // Common from European locale exports.
    expect(detectDelimiter('a;b;c')).toBe(';')
  })

  it('does not let a delimiter inside quotes vote', () => {
    expect(detectDelimiter('"a,b,c,d,e"\tx\ty')).toBe('\t')
  })

  it('looks only at the first record, newlines in quotes included', () => {
    expect(detectDelimiter('"x\ny;z;w";a')).toBe(';')
  })

  it('falls back to comma for a single-column file', () => {
    expect(detectDelimiter('model')).toBe(',')
  })

  it('is overridable', () => {
    expect(parseCsv('a|b\n1|2', '|').header).toEqual(['a', 'b'])
  })
})

describe('rejections', () => {
  it('rejects an empty file', () => {
    expect(() => parseCsv('')).toThrow(CsvError)
    expect(() => parseCsv('   \n  ')).toThrow(/empty/)
  })
})
