import { useMemo, useState } from 'react'

import { buildAnalysis, scoreTurns, withPriceableCalls } from '../engine/analysis'
import type { Classification } from '../engine/classification'
import { parseCsv } from '../engine/csv'
import type { ParsedCsv } from '../engine/csv'
import { detectColumns, ingestParsed } from '../engine/csvIngest'
import type { ColumnMapping, CsvIngestResult } from '../engine/csvIngest'
import {
  buildLabelQueue,
  labelProgress,
  spendCoveredBy,
  toClassifications,
} from '../engine/labeling'
import type { PartialLabel } from '../engine/labeling'
import { formatMoney } from '../engine/money'
import type { Turn } from '../engine/models'
import { pct, usd } from '../format'
import type { Analysis } from '../types'
import { ClassifyPanel } from './ClassifyPanel'
import { ColumnMapper } from './ColumnMapper'
import { CallsPerTurn, CostBreakdown } from './CostBreakdown'
import { FileDrop } from './FileDrop'
import { LabelingPanel } from './LabelingPanel'
import { Leaderboard } from './Leaderboard'
import { Overview } from './Overview'
import { Heatmap, WasteSummary } from './WastePanel'

/**
 * A file this large would lock the tab up while it parses. The reader holds the
 * whole file in memory by design, so the honest move is to refuse with a reason
 * rather than appear to hang.
 */
const MAX_BYTES = 50 * 1024 * 1024

/**
 * The size of pass worth quoting up front.
 *
 * Ten turns took 45% of the reference corpus's spend. The figure shown is always
 * computed from the file in hand, never borrowed — a flat export genuinely does
 * not have that shape, and promising it would be the wrong kind of confident.
 */
const SHORT_PASS = 10

/** Which way the person is judging prompts, if they are. */
type Mode = 'none' | 'labelling' | 'classifying'

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
  /** Priceable turns, kept so the file can be re-scored as labels arrive. */
  turns: Turn[]
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
  return { ingest, turns, analysis: buildAnalysis(turns), droppedCalls, droppedModels }
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
  const { ingest, droppedCalls, droppedModels } = report
  const { stats, issues, unmappedColumns, mapping } = ingest

  // Judgements live here rather than in the screens that produce them, so
  // closing one keeps the work and the figures below update as it arrives.
  const [labels, setLabels] = useState<Map<string, PartialLabel>>(() => new Map())
  const [classified, setClassified] = useState<Map<string, Classification>>(
    () => new Map(),
  )
  const [mode, setMode] = useState<Mode>('none')

  const queue = useMemo(() => buildLabelQueue(report.turns), [report.turns])

  /**
   * Hand labels and classifier output, kept apart until here.
   *
   * They are deliberately not merged into one editable map: each
   * `Classification` carries the model that produced it, and flattening a human
   * judgement and a prediction into the same shape is exactly what stops
   * `classificationSource()` from being able to say `mixed`.
   *
   * Hand labels win on a collision. For the turns a person actually judged, a
   * human answer is the better input — and it is the reference the classifier
   * is meant to be measured against, not the other way round.
   */
  const classifications = useMemo(() => {
    const merged = new Map(classified)
    for (const [turnId, found] of toClassifications(labels)) merged.set(turnId, found)
    return merged
  }, [classified, labels])

  const addClassified = (found: Map<string, Classification>) =>
    setClassified((current) => new Map([...current, ...found]))

  // Rescoring re-derives the bloat and calls-per-turn baselines from the labelled
  // turns, so every figure moves as the labelling proceeds. That is correct
  // rather than unstable: the reference is your own comparable work, and there
  // is less of it to compare against after two labels than after twenty.
  const analysis = useMemo(() => {
    if (!classifications.size) return report.analysis
    const { scores } = scoreTurns(report.turns, classifications)
    return buildAnalysis(report.turns, { classifications, scores })
  }, [report, classifications])

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

      <WasteSection
        analysis={analysis}
        queue={queue}
        labels={labels}
        classifications={classifications}
        mode={mode}
        onLabels={setLabels}
        onClassified={addClassified}
        onMode={setMode}
      />
    </div>
  )
}

/**
 * Waste for an uploaded file: unmeasured, being measured, or measured.
 *
 * The unmeasured state is deliberately not zeros. Nothing here claims a file has
 * no waste until enough of its spend has actually been judged, and the scored
 * figures below always say how much of the file they cover.
 */
function WasteSection({
  analysis,
  queue,
  labels,
  classifications,
  mode,
  onLabels,
  onClassified,
  onMode,
}: {
  analysis: Analysis
  queue: ReturnType<typeof buildLabelQueue>
  labels: Map<string, PartialLabel>
  classifications: Map<string, Classification>
  mode: Mode
  onLabels: (labels: Map<string, PartialLabel>) => void
  onClassified: (found: Map<string, Classification>) => void
  onMode: (mode: Mode) => void
}) {
  const progress = labelProgress(queue, labels)
  const { waste, overview } = analysis
  const close = () => onMode('none')

  // Judged by any means, not just by hand — what the classifier covered counts
  // toward the same total and must not be re-bought.
  const judged = queue.tasks.filter((task) =>
    classifications.has(task.turn.turn_id),
  ).length

  if (mode === 'labelling') {
    return (
      <section>
        <div className="section-head">
          <h2>Waste</h2>
          <span className="section-note">
            {pct(progress.spendShare)} of labellable spend judged by hand
          </span>
        </div>
        <LabelingPanel
          queue={queue}
          labels={labels}
          onChange={onLabels}
          onDone={close}
          onCancel={close}
        />
      </section>
    )
  }

  if (mode === 'classifying') {
    return (
      <section>
        <div className="section-head">
          <h2>Waste</h2>
        </div>
        <ClassifyPanel
          queue={queue}
          existing={classifications}
          onClassified={onClassified}
          onClose={close}
        />
      </section>
    )
  }

  if (!waste) {
    return (
      <section>
        <div className="section-head">
          <h2>Waste</h2>
        </div>
        <div className="notice">
          <h3>Not measured yet</h3>
          <p>
            This is what the file cost. Scoring the gap between that and what it should
            have cost needs each prompt judged for task complexity — the only input the
            numbers above cannot supply. {queue.tasks.length} of {overview.turns} turns
            here carry prompt text.
            {/* Only a claim when there is something to concentrate. Below a short
                pass the "top ten cover most of it" line reduces to "all of them
                cover all of it", which is true and worth nobody's attention. */}
            {queue.tasks.length > SHORT_PASS &&
              ` They are ordered most expensive first, and the top ${SHORT_PASS}` +
                ` alone carry ${pct(spendCoveredBy(queue, SHORT_PASS))} of their spend.`}
          </p>
          <div className="drop-actions" style={{ justifyContent: 'flex-start' }}>
            <button
              type="button"
              className="primary"
              onClick={() => onMode('labelling')}
              disabled={queue.tasks.length === 0}
            >
              Label {queue.tasks.length} prompt{queue.tasks.length === 1 ? '' : 's'}{' '}
              yourself
            </button>
            <button
              type="button"
              onClick={() => onMode('classifying')}
              disabled={queue.tasks.length === 0}
            >
              Classify with Claude
            </button>
          </div>
          <p className="section-note">
            Labelling costs nothing and needs no key. Claude needs an Anthropic key and
            costs cents; it quotes the price before spending anything.
          </p>
          {queue.tasks.length === 0 && (
            <p>
              No row in this file carried prompt text, so there is nothing to judge. Map
              a prompt column and analyze again if the export has one.
            </p>
          )}
        </div>
      </section>
    )
  }

  return (
    <>
      <section>
        <div className="section-head">
          <h2>Waste</h2>
          <span className="section-note">
            {judged} of {progress.total} prompts judged ·{' '}
            {pct(progress.fileShare)} of the file's spend scored
          </span>
        </div>
        <WasteSummary waste={waste} />
        {judged < progress.total && (
          <div className="notice" style={{ marginTop: 10 }}>
            <h3>Partial by design, and it says so</h3>
            <p>
              These figures cover the {judged} turn{judged === 1 ? '' : 's'} judged so
              far — {usd(waste.scored_cost)} of{' '}
              {usd(formatMoney(progress.queueCost))} labellable spend. The rest are not
              counted as waste-free; they are not counted at all.
            </p>
            <div className="drop-actions" style={{ justifyContent: 'flex-start' }}>
              <button type="button" onClick={() => onMode('labelling')}>
                Label {progress.total - judged} more
              </button>
              <button type="button" onClick={() => onMode('classifying')}>
                Classify the rest with Claude
              </button>
            </div>
          </div>
        )}
      </section>

      <section>
        <div className="section-head">
          <h2>Complexity vs. tier</h2>
        </div>
        <Heatmap waste={waste} />
      </section>

      <section>
        <div className="section-head">
          <h2>Waste leaderboard</h2>
          <span className="section-note">worst turns by estimated dollar waste</span>
        </div>
        <Leaderboard rows={waste.leaderboard} />
      </section>
    </>
  )
}
