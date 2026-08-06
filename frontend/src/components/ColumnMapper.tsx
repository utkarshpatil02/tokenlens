import { MAPPABLE_FIELDS } from '../engine/csvIngest'
import type { ColumnMapping, MappableField } from '../engine/csvIngest'
import { truncate } from '../format'

interface Props {
  fileName: string
  header: string[]
  sampleRows: string[][]
  rowCount: number
  mapping: ColumnMapping
  onChange: (mapping: ColumnMapping) => void
  onConfirm: () => void
  onCancel: () => void
}

const PREVIEW_ROWS = 5

/**
 * Column confirmation.
 *
 * Header names are not a standard, so detection can only ever be a guess. This
 * screen exists because the alternative — applying the guess silently — turns a
 * misread column into a wrong dollar figure with nothing on screen to question.
 * Guesses arrive pre-filled, so the common case is one glance and a click.
 *
 * The cache-inclusive control is the one genuinely subtle input on the page.
 * OpenAI's `prompt_tokens` counts cached tokens; Anthropic's `input_tokens` does
 * not. Getting it backwards double-counts exactly the traffic that dominates
 * agentic spend, so the question is asked in plain language rather than inferred
 * and forgotten.
 */
export function ColumnMapper({
  fileName,
  header,
  sampleRows,
  rowCount,
  mapping,
  onChange,
  onConfirm,
  onCancel,
}: Props) {
  const set = (field: MappableField, value: string) => {
    const next: ColumnMapping = {
      ...mapping,
      [field]: value === '' ? null : Number(value),
    }
    // The subtraction has nothing to subtract without a cache-read column.
    if (next.cache_read === null || next.input_tokens === null) {
      next.inputIncludesCache = false
    }
    onChange(next)
  }

  const assigned = MAPPABLE_FIELDS.map(({ field }) => mapping[field]).filter(
    (index): index is number => index !== null,
  )
  const reused = new Set(
    assigned.filter((index, position) => assigned.indexOf(index) !== position),
  )

  const labelFor = new Map<number, string>()
  for (const { field, label } of MAPPABLE_FIELDS) {
    const index = mapping[field]
    if (index !== null && !labelFor.has(index)) labelFor.set(index, label)
  }

  const canSubtract = mapping.input_tokens !== null && mapping.cache_read !== null

  return (
    <div className="mapper">
      <div className="mapper-head">
        <div>
          <h3>{fileName}</h3>
          <p className="section-note">
            {rowCount.toLocaleString()} data row{rowCount === 1 ? '' : 's'} ·{' '}
            {header.length} column{header.length === 1 ? '' : 's'} · confirm what each
            one holds
          </p>
        </div>
        <div className="mapper-actions">
          <button type="button" onClick={onCancel}>
            Start over
          </button>
          <button
            type="button"
            className="primary"
            onClick={onConfirm}
            disabled={mapping.model === null}
          >
            Analyze
          </button>
        </div>
      </div>

      {mapping.model === null && (
        <div className="notice error">
          <h3>Pick the model column</h3>
          <p>
            A call cannot be priced without knowing which model ran it. Everything else
            on this list is optional.
          </p>
        </div>
      )}

      <div className="mapper-grid">
        {MAPPABLE_FIELDS.map(({ field, label, required }) => (
          <label key={field} className="mapper-field">
            <span className="mapper-label">
              {label}
              {required && <span className="req"> required</span>}
            </span>
            <select
              value={mapping[field] === null ? '' : String(mapping[field])}
              onChange={(event) => set(field, event.target.value)}
            >
              <option value="">— not in this file —</option>
              {header.map((name, index) => (
                <option key={index} value={index}>
                  {name || `column ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      {canSubtract && (
        <label className="mapper-check">
          <input
            type="checkbox"
            checked={mapping.inputIncludesCache}
            onChange={(event) =>
              onChange({ ...mapping, inputIncludesCache: event.target.checked })
            }
          />
          <span>
            The input column already counts cached tokens
            <span className="mapper-hint">
              True for OpenAI's <code>prompt_tokens</code>, false for Anthropic's{' '}
              <code>input_tokens</code>. When true, cache reads are subtracted so they
              are not billed twice.
            </span>
          </span>
        </label>
      )}

      {reused.size > 0 && (
        <div className="notice">
          <h3>One column is doing two jobs</h3>
          <p>
            {[...reused].map((index) => header[index]).join(', ')} is mapped to more than
            one field, so its tokens will be counted more than once. That is almost
            certainly not what you want.
          </p>
        </div>
      )}

      <div className="scroll-x preview">
        <table>
          <thead>
            <tr>
              {header.map((name, index) => (
                <th key={index} className={labelFor.has(index) ? 'mapped' : undefined}>
                  {name || `column ${index + 1}`}
                  <span className="col-role">{labelFor.get(index) ?? 'unused'}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sampleRows.slice(0, PREVIEW_ROWS).map((row, rowIndex) => (
              <tr key={rowIndex}>
                {header.map((_, index) => (
                  <td key={index}>{truncate(row[index] ?? '', 40)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
