import { useMemo, useRef, useState } from 'react'

import { createClaudeBackend } from '../engine/claude'
import type { Classification } from '../engine/classification'
import { classifyQueue, renderPrompt } from '../engine/classifier'
import type { ClassifyProgress, ClassifyRun } from '../engine/classifier'
import { spendCoveredBy } from '../engine/labeling'
import type { LabelQueue } from '../engine/labeling'
import { formatMoney } from '../engine/money'
import { pct, usd } from '../format'

interface Props {
  queue: LabelQueue
  /** Turns already judged, by hand or by an earlier run. Never re-sent. */
  existing: Map<string, Classification>
  onClassified: (found: Map<string, Classification>) => void
  onClose: () => void
}

/**
 * sessionStorage, never localStorage.
 *
 * The difference is the whole point: this key survives a page refresh and dies
 * with the tab. A key in localStorage outlives the visit, and this page has no
 * business holding someone's credential after they have closed it.
 */
const KEY_STORAGE = 'tokenlens.anthropic-key'

const readKey = (): string => {
  try {
    return sessionStorage.getItem(KEY_STORAGE) ?? ''
  } catch {
    // Private-browsing modes can throw on access. A missing key is recoverable;
    // a blank screen is not.
    return ''
  }
}

const writeKey = (key: string) => {
  try {
    if (key) sessionStorage.setItem(KEY_STORAGE, key)
    else sessionStorage.removeItem(KEY_STORAGE)
  } catch {
    /* Nothing to do — the run still works, it just will not be remembered. */
  }
}

/** Cost-ordered, so a cap always buys the most expensive turns first. */
const SLICE_OPTIONS = [10, 30, 50]

type State =
  | { kind: 'idle' }
  | { kind: 'running'; progress: ClassifyProgress }
  | { kind: 'done'; run: ClassifyRun }
  | { kind: 'failed'; message: string }

/**
 * Classification by Claude, from the browser.
 *
 * The order here is deliberate: how much, then how much it costs, then the key,
 * then the button. Nothing is spent before the estimate has been on screen, and
 * the run can be stopped at any point without losing what it has already
 * bought.
 */
export function ClassifyPanel({ queue, existing, onClassified, onClose }: Props) {
  const [key, setKey] = useState(readKey)
  const [remember, setRemember] = useState(() => Boolean(readKey()))
  const [limit, setLimit] = useState<number | null>(null)
  const [state, setState] = useState<State>({ kind: 'idle' })
  const abort = useRef<AbortController | null>(null)

  const pending = useMemo(
    () => queue.tasks.filter((task) => !existing.has(task.turn.turn_id)),
    [queue, existing],
  )
  const slice = useMemo(
    () => (limit === null ? pending : pending.slice(0, limit)),
    [pending, limit],
  )

  // Priced without a key: the estimate is the thing that justifies typing one.
  const estimate = useMemo(
    () =>
      createClaudeBackend('').estimate(
        slice.map((task) => renderPrompt(task.turn.prompt_text ?? '')),
      ),
    [slice],
  )

  const run = async () => {
    const controller = new AbortController()
    abort.current = controller
    setState({
      kind: 'running',
      progress: {
        done: 0,
        failed: 0,
        total: slice.length,
        spendCovered: 0n,
        spendShare: 0,
        inFlight: null,
      },
    })

    try {
      const result = await classifyQueue(createClaudeBackend(key), queue, {
        existing,
        limit: limit ?? undefined,
        signal: controller.signal,
        onProgress: (progress) => setState({ kind: 'running', progress }),
      })
      // Handed up even when the run was stopped or partly failed — every
      // answer in it was paid for.
      onClassified(result.classifications)
      setState({ kind: 'done', run: result })
    } catch (error) {
      setState({
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      abort.current = null
    }
  }

  const start = () => {
    writeKey(remember ? key : '')
    void run()
  }

  return (
    <div className="labeler">
      <div className="mapper-head">
        <div>
          <h3>Classify with Claude</h3>
          <p className="section-note">
            Haiku 4.5 reads each prompt, escalating to Sonnet 5 only where it is unsure.
            Your key goes to Anthropic and nowhere else.
          </p>
        </div>
        <div className="mapper-actions">
          <button type="button" onClick={onClose}>
            {state.kind === 'done' ? 'Done' : 'Close'}
          </button>
        </div>
      </div>

      {state.kind === 'idle' && (
        <>
          <div className="panel">
            <div className="labeler-axis">
              <div className="labeler-axis-head">
                <h4>How many</h4>
                <span className="labeler-axis-note">
                  most expensive first, so a cap buys the turns that matter
                </span>
              </div>
              <div className="labeler-choices">
                {[...SLICE_OPTIONS.filter((n) => n < pending.length), null].map(
                  (option) => (
                    <button
                      key={option ?? 'all'}
                      type="button"
                      className={`labeler-choice${limit === option ? ' chosen' : ''}`}
                      onClick={() => setLimit(option)}
                    >
                      <span className="labeler-choice-name">
                        {option === null ? `All ${pending.length}` : `Top ${option}`}
                      </span>
                      <span className="labeler-choice-help">
                        {pct(spendCoveredBy(queue, option ?? pending.length))} of
                        labellable spend
                      </span>
                    </button>
                  ),
                )}
              </div>
            </div>

            <div className="labeler-axis">
              <div className="labeler-axis-head">
                <h4>Estimated cost</h4>
              </div>
              <div className="labeler-card-head">
                <span className="labeler-cost">
                  {estimate.cost === null ? 'unknown' : usd(formatMoney(estimate.cost))}
                </span>
                <span className="labeler-meta">
                  {slice.length} prompt{slice.length === 1 ? '' : 's'}
                  {existing.size > 0 &&
                    ` · ${existing.size} already judged and not re-sent`}
                </span>
              </div>
              <p className="section-note" style={{ maxWidth: '70ch' }}>
                {estimate.note}
              </p>
            </div>
          </div>

          <div className="panel" style={{ marginTop: 10 }}>
            <h3>Anthropic API key</h3>
            <label className="mapper-field" style={{ maxWidth: 520 }}>
              <span className="mapper-label">
                secret key<span className="req"> required</span>
              </span>
              <input
                type="password"
                value={key}
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-ant-…"
                onChange={(event) => setKey(event.target.value.trim())}
              />
            </label>
            <label className="mapper-check">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
              />
              <span>
                Keep it for this tab
                <span className="mapper-hint">
                  Stored in <code>sessionStorage</code>, which is cleared when the tab
                  closes — never in <code>localStorage</code>, and never sent anywhere
                  but Anthropic. There is no free API tier; a Claude.ai subscription is
                  not an API key.
                </span>
              </span>
            </label>
            <div className="labeler-nav">
              <span className="labeler-hint">
                Nothing is spent until you press this.
              </span>
              <button
                type="button"
                className="primary"
                onClick={start}
                disabled={!key || slice.length === 0}
              >
                Classify {slice.length} prompt{slice.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </>
      )}

      {state.kind === 'running' && (
        <Running progress={state.progress} onStop={() => abort.current?.abort()} />
      )}

      {state.kind === 'done' && <Summary run={state.run} onAgain={() => setState({ kind: 'idle' })} />}

      {state.kind === 'failed' && (
        <div className="notice error">
          <h3>The run could not start</h3>
          <p>{state.message}</p>
          <button type="button" onClick={() => setState({ kind: 'idle' })}>
            Back
          </button>
        </div>
      )}
    </div>
  )
}

function Running({
  progress,
  onStop,
}: {
  progress: ClassifyProgress
  onStop: () => void
}) {
  const share = progress.total ? progress.done / progress.total : 0
  return (
    <div className="panel">
      <div className="labeler-progress">
        <div className="labeler-track">
          <span className="labeler-fill" style={{ width: `${share * 100}%` }} />
        </div>
        <div className="labeler-progress-meta">
          <span className="labeler-covered">
            {pct(progress.spendShare)} of spend covered
          </span>
          <span>
            {progress.done} of {progress.total} classified
            {progress.failed > 0 && ` · ${progress.failed} failed`}
          </span>
        </div>
      </div>
      <div className="labeler-nav">
        <span className="labeler-hint">
          {progress.inFlight
            ? 'Working — stopping keeps everything already classified.'
            : 'Finishing up…'}
        </span>
        <button type="button" onClick={onStop}>
          Stop
        </button>
      </div>
    </div>
  )
}

function Summary({ run, onAgain }: { run: ClassifyRun; onAgain: () => void }) {
  return (
    <div className="notice">
      <h3>
        {run.classifications.size} prompt{run.classifications.size === 1 ? '' : 's'}{' '}
        classified
      </h3>
      <p>
        Covering {pct(run.spendShare)} of labellable spend.
        {run.remaining > 0 &&
          ` ${run.remaining} turn${run.remaining === 1 ? '' : 's'} remain unjudged and are not counted as waste-free — they are not counted at all.`}
      </p>
      {run.abandonedBecause && (
        <p style={{ color: 'var(--crit)' }}>
          Stopped early after repeated failures: {run.abandonedBecause}
        </p>
      )}
      {run.failures.length > 0 && (
        <details className="issues">
          <summary>
            {run.failures.length} prompt{run.failures.length === 1 ? '' : 's'} failed
          </summary>
          <ul className="findings">
            {run.failures.slice(0, 10).map((failure) => (
              <li key={failure.turnId}>
                {failure.turnId}: {failure.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {run.remaining > 0 && (
        <button type="button" onClick={onAgain}>
          Classify more
        </button>
      )}
    </div>
  )
}
