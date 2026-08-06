import { useState } from 'react'

import { buildAnalysis, withPriceableCalls } from '../engine/analysis'
import { parseCsv } from '../engine/csv'
import type { ParsedCsv } from '../engine/csv'
import { detectColumns, ingestParsed } from '../engine/csvIngest'
import type { ColumnMapping, CsvIngestResult } from '../engine/csvIngest'
import { usd } from '../format'
import type { Analysis } from '../types'
import { ColumnMapper } from './ColumnMapper'
import { CallsPerTurn, CostBreakdown } from './CostBreakdown'
import { FileDrop } from './FileDrop'
import { Overview } from './Overview'

/**
 * A file this large would lock the tab up while it parses. The reader holds the
 * whole file in memory by design, so the honest move is to refuse with a reason
 * rather than appear to hang.
 */
const MAX_BYTES = 50 * 1024 * 1024

/** Enough rows to show the shape of a real agentic export, in a few lines. */
const SAMPLE_CSV = [
  'model,timestamp,input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,trace_id,session_id,prompt',
  'claude-opus-5,2026-07-26T09:14:02Z,2,286,34488,12359,t1,s1,"port the pricing engine to TypeScript"',
  'claude-opus-5,2026-07-26T09:14:31Z,0,1204,46847,0,t1,s1,',
  'claude-opus-5,2026-07-26T09:15:10Z,0,318,58203,0,t1,s1,',
  'claude-opus-5,2026-07-26T10:02:11Z,4,52,18220,6100,t2,s1,"rename this variable"',
  'claude-haiku-4-5,2026-07-26T10:44:57Z,120,88,0,0,t3,s1,"what does cache_write_1h mean?"',
  'claude-sonnet-5,2026-07-26T11:19:03Z,8,940,29115,8800,t4,s2,"write tests for the CSV reader"',
  'claude-sonnet-5,2026-07-26T11:19:48Z,0,612,33901,0,t4,s2,',
].join('\n')

type State =
  | { kind: 'empty' }
  | { kind: 'reading'; name: string }
  | { kind: 'mapping'; name: string; parsed: ParsedCsv; mapping: ColumnMapping }
  | { kind: 'ready'; name: string; report: Report }
  | { kind: 'failed'; name: string; message: string }

interface Report {
  ingest: CsvIngestResult
  analysis: Analysis
  droppedCalls: number
  droppedModels: string[]
}

/**
 * Build the dashboard payload from an ingested file.
 *
 * Unpriceable calls are removed first and counted. `buildAnalysis` raises on an
 * unknown model, matching the CLI — the right default when reading your own
 * logs, the wrong one when handed an arbitrary export, so the leniency lives
 * here where it can be reported rather than inside the engine where it would be
 * silent.
 */
const analyze = (ingest: CsvIngestResult): Report => {
  const { turns, droppedCalls, droppedModels } = withPriceableCalls(ingest.turns)
  return { ingest, analysis: buildAnalysis(turns), droppedCalls, droppedModels }
}

/**
 * The upload path, from empty file picker to a costed dashboard.
 *
 * Everything happens in this tab: the file is read, parsed, mapped, priced and
 * aggregated without a network request, which is what makes "nothing leaves your
 * browser" a fact about the architecture rather than a promise in the copy.
 */
export function IngestPanel() {
  const [state, setState] = useState<State>({ kind: 'empty' })

  const fail = (name: string, error: unknown) =>
    setState({
      kind: 'failed',
      name,
      message: error instanceof Error ? error.message : String(error),
    })

  const load = async (name: string, read: () => Promise<string>) => {
    setState({ kind: 'reading', name })
    try {
      const text = await read()
      const parsed = parseCsv(text)
      setState({ kind: 'mapping', name, parsed, mapping: detectColumns(parsed.header) })
    } catch (error) {
      fail(name, error)
    }
  }

  const onFile = (file: File) => {
    if (file.size > MAX_BYTES) {
      setState({
        kind: 'failed',
        name: file.name,
        message: `That file is ${(file.size / 1024 / 1024).toFixed(0)} MB. Parsing happens in this tab and holds the whole file in memory, so anything over ${MAX_BYTES / 1024 / 1024} MB is refused rather than left to hang.`,
      })
      return
    }
    void load(file.name, () => file.text())
  }

  const confirm = () => {
    if (state.kind !== 'mapping') return
    try {
      setState({
        kind: 'ready',
        name: state.name,
        report: analyze(ingestParsed(state.parsed, state.mapping)),
      })
    } catch (error) {
      fail(state.name, error)
    }
  }

  const reset = () => setState({ kind: 'empty' })

  return (
    <section>
      <div className="section-head">
        <h2>Analyze your own export</h2>
        <span className="section-note badge-private">nothing leaves your browser</span>
      </div>

      {state.kind === 'empty' && (
        <FileDrop
          busy={false}
          onFile={onFile}
          onSample={() => void load('sample-export.csv', async () => SAMPLE_CSV)}
        />
      )}

      {state.kind === 'reading' && <div className="center">Reading {state.name}…</div>}

      {state.kind === 'mapping' && (
        <ColumnMapper
          fileName={state.name}
          header={state.parsed.header}
          sampleRows={state.parsed.rows}
          rowCount={state.parsed.rows.length}
          mapping={state.mapping}
          onChange={(mapping) => setState({ ...state, mapping })}
          onConfirm={confirm}
          onCancel={reset}
        />
      )}

      {state.kind === 'failed' && (
        <div className="notice error">
          <h3>Could not read {state.name}</h3>
          <p>{state.message}</p>
          <button type="button" onClick={reset}>
            Try another file
          </button>
        </div>
      )}

      {state.kind === 'ready' && (
        <Result name={state.name} report={state.report} onReset={reset} />
      )}
    </section>
  )
}

function Result({
  name,
  report,
  onReset,
}: {
  name: string
  report: Report
  onReset: () => void
}) {
  const { ingest, analysis, droppedCalls, droppedModels } = report
  const { stats, issues, unmappedColumns, mapping } = ingest
  const uncachedInput = analysis.cost_by_token_category.find(
    (row) => row.category === 'input_tokens',
  )
  const cacheRead = analysis.cost_by_token_category.find(
    (row) => row.category === 'cache_read',
  )
  // Only worth saying when it is true of this file. On a single-shot export with
  // no cache traffic the same sentence would be actively misleading.
  const cacheDominates = (cacheRead?.share ?? 0) > 0.5 && uncachedInput !== undefined

  return (
    <div className="result">
      <div className="mapper-head">
        <div>
          <h3>{name}</h3>
          <p className="section-note">
            {ingest.profile === 'agentic'
              ? 'agentic — calls grouped under the prompt that caused them'
              : 'single-shot — one call per turn'}
            {mapping.inputIncludesCache && ' · cache reads subtracted from input'}
          </p>
        </div>
        <div className="mapper-actions">
          <button type="button" onClick={onReset}>
            Analyze another file
          </button>
        </div>
      </div>

      <Overview data={analysis.overview} />

      {analysis.cost_by_token_category.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Where the money went</h2>
            {cacheDominates && (
              <span className="section-note">
                uncached input is only {usd(uncachedInput!.cost)} — cost is carried by
                cache traffic
              </span>
            )}
          </div>
          <CostBreakdown
            byCategory={analysis.cost_by_token_category}
            byModel={analysis.cost_by_model}
          />
        </section>
      )}

      {analysis.calls_per_turn.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Turn shape</h2>
          </div>
          <CallsPerTurn rows={analysis.calls_per_turn} />
        </section>
      )}

      {(stats.skipped > 0 ||
        stats.duplicates > 0 ||
        stats.missingTimestamps > 0 ||
        droppedModels.length > 0 ||
        unmappedColumns.length > 0) && (
        <section>
          <div className="section-head">
            <h2>What the file did not cleanly give up</h2>
          </div>
          <div className="notice">
            <ul className="findings">
              {stats.duplicates > 0 && (
                <li>
                  {stats.duplicates} duplicate row{stats.duplicates === 1 ? '' : 's'}{' '}
                  removed by request id — counting them would have roughly doubled the
                  total.
                </li>
              )}
              {stats.skipped > 0 && (
                <li>
                  {stats.skipped} row{stats.skipped === 1 ? '' : 's'} skipped for having
                  no model, so that spend is not in the figures above.
                </li>
              )}
              {stats.missingTimestamps > 0 && (
                <li>
                  {stats.missingTimestamps} call
                  {stats.missingTimestamps === 1 ? '' : 's'} with no usable timestamp,
                  priced at list rates — a promotional rate is never assumed.
                </li>
              )}
              {droppedModels.length > 0 && (
                <li>
                  No rates for {droppedModels.join(', ')} — {droppedCalls} call
                  {droppedCalls === 1 ? '' : 's'} excluded rather than priced at zero.
                </li>
              )}
              {unmappedColumns.length > 0 && (
                <li className="quiet">
                  Columns left unused: {unmappedColumns.join(', ')}.
                </li>
              )}
            </ul>
          </div>
        </section>
      )}

      {issues.length > 0 && (
        <details className="issues">
          <summary>
            {issues.length} row issue{issues.length === 1 ? '' : 's'}
          </summary>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th className="num">line</th>
                  <th>what happened</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((issue, index) => (
                  <tr key={index}>
                    <td className="num">{issue.line}</td>
                    <td>{issue.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <section>
        <div className="section-head">
          <h2>Waste</h2>
        </div>
        <div className="notice">
          <h3>Not measured yet</h3>
          <p>
            This is what the file cost. Scoring the gap between that and what it should
            have cost needs each prompt classified by task complexity — the one step that
            costs money, and the piece still to build.{' '}
            {analysis.overview.scorable_turns} of {analysis.overview.turns} turns here
            carry prompt text and would be scorable.
          </p>
        </div>
      </section>
    </div>
  )
}
