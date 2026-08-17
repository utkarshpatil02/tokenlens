import { useCallback, useMemo, useState } from 'react'

import { buildAnalysis, scoreTurns, withPriceableCalls } from './engine/analysis'
import type { Classification } from './engine/classification'
import { parseCsv } from './engine/csv'
import type { ParsedCsv } from './engine/csv'
import { detectColumns, ingestParsed } from './engine/csvIngest'
import type { ColumnMapping, CsvIngestResult } from './engine/csvIngest'
import { buildLabelQueue, toClassifications } from './engine/labeling'
import type { PartialLabel } from './engine/labeling'
import type { Turn } from './engine/models'
import type { Analysis } from './types'

/**
 * A file this large would lock the tab up while it parses. The reader holds the
 * whole file in memory by design, so the honest move is to refuse with a reason
 * rather than appear to hang.
 */
export const MAX_BYTES = 50 * 1024 * 1024

/** Which way the person is judging prompts, if they are. */
export type Mode = 'none' | 'labelling' | 'classifying'

export interface Report {
  ingest: CsvIngestResult
  /** Priceable turns, kept so the file can be re-scored as labels arrive. */
  turns: Turn[]
  analysis: Analysis
  droppedCalls: number
  droppedModels: string[]
}

export type SessionState =
  | { kind: 'empty' }
  | { kind: 'reading'; name: string }
  | { kind: 'mapping'; name: string; parsed: ParsedCsv; mapping: ColumnMapping }
  | { kind: 'ready'; name: string; report: Report }
  | { kind: 'failed'; name: string; message: string }

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
 * Everything about the uploaded file, owned above the router.
 *
 * This used to live inside the panel that rendered it, which was fine while the
 * whole app was one scrolling page. With navigation it is not: moving from
 * Waste to Overview would unmount the panel and silently destroy the parsed
 * file, every hand label and every paid-for classifier answer. Hoisting the
 * state is what makes navigation safe, so it is a prerequisite for the router
 * rather than a tidy-up alongside it.
 */
export function useUploadSession() {
  const [state, setState] = useState<SessionState>({ kind: 'empty' })
  const [labels, setLabels] = useState<Map<string, PartialLabel>>(() => new Map())
  const [classified, setClassified] = useState<Map<string, Classification>>(
    () => new Map(),
  )
  const [mode, setMode] = useState<Mode>('none')

  const fail = (name: string, error: unknown) =>
    setState({
      kind: 'failed',
      name,
      message: error instanceof Error ? error.message : String(error),
    })

  const load = useCallback(async (name: string, read: () => Promise<string>) => {
    setState({ kind: 'reading', name })
    try {
      const text = await read()
      const parsed = parseCsv(text)
      setState({ kind: 'mapping', name, parsed, mapping: detectColumns(parsed.header) })
    } catch (error) {
      fail(name, error)
    }
  }, [])

  const onFile = useCallback(
    (file: File) => {
      if (file.size > MAX_BYTES) {
        setState({
          kind: 'failed',
          name: file.name,
          message: `That file is ${(file.size / 1024 / 1024).toFixed(0)} MB. Parsing happens in this tab and holds the whole file in memory, so anything over ${MAX_BYTES / 1024 / 1024} MB is refused rather than left to hang.`,
        })
        return
      }
      void load(file.name, () => file.text())
    },
    [load],
  )

  const setMapping = useCallback((mapping: ColumnMapping) => {
    setState((current) =>
      current.kind === 'mapping' ? { ...current, mapping } : current,
    )
  }, [])

  const confirm = useCallback(() => {
    setState((current) => {
      if (current.kind !== 'mapping') return current
      try {
        return {
          kind: 'ready',
          name: current.name,
          report: analyze(ingestParsed(current.parsed, current.mapping)),
        }
      } catch (error) {
        return {
          kind: 'failed',
          name: current.name,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    })
  }, [])

  /** Clears the file and every judgement made about it. */
  const reset = useCallback(() => {
    setState({ kind: 'empty' })
    setLabels(new Map())
    setClassified(new Map())
    setMode('none')
  }, [])

  const addClassified = useCallback(
    (found: Map<string, Classification>) =>
      setClassified((current) => new Map([...current, ...found])),
    [],
  )

  const report = state.kind === 'ready' ? state.report : null

  const queue = useMemo(
    () => (report ? buildLabelQueue(report.turns) : null),
    [report],
  )

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

  // Rescoring re-derives the bloat and calls-per-turn baselines from the labelled
  // turns, so every figure moves as the labelling proceeds. That is correct
  // rather than unstable: the reference is your own comparable work, and there
  // is less of it to compare against after two labels than after twenty.
  const analysis = useMemo(() => {
    if (!report) return null
    if (!classifications.size) return report.analysis
    const { scores } = scoreTurns(report.turns, classifications)
    return buildAnalysis(report.turns, { classifications, scores })
  }, [report, classifications])

  return {
    state,
    report,
    analysis,
    queue,
    labels,
    classified,
    classifications,
    mode,
    hasFile: state.kind === 'ready',
    onFile,
    load,
    setMapping,
    confirm,
    reset,
    setLabels,
    addClassified,
    setMode,
  }
}

export type UploadSession = ReturnType<typeof useUploadSession>
