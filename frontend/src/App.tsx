import { useCallback, useEffect, useState } from 'react'

import { fetchAnalysis, fetchHealth, runClassification } from './api'
import { CallsPerTurn, CostBreakdown } from './components/CostBreakdown'
import { Leaderboard } from './components/Leaderboard'
import { Overview } from './components/Overview'
import { Heatmap, WasteSummary } from './components/WastePanel'
import { usd } from './format'
import type { Analysis, Health } from './types'

export default function App() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [classifying, setClassifying] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [data, status] = await Promise.all([fetchAnalysis(), fetchHealth()])
      setAnalysis(data)
      setHealth(status)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Billable, so it is only ever triggered by an explicit click.
  const classify = async () => {
    setClassifying(true)
    setError(null)
    try {
      setAnalysis(await runClassification())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setClassifying(false)
    }
  }

  if (error && !analysis) {
    return (
      <div className="app">
        <div className="notice error">
          <h3>Could not load analysis</h3>
          <p>{error}</p>
          <button onClick={() => void load()}>Retry</button>
        </div>
      </div>
    )
  }

  if (!analysis) {
    return <div className="center">Reading local session logs…</div>
  }

  const { overview, waste, rate_table } = analysis
  const unclassified = overview.scorable_turns - overview.classified_turns
  const uncachedInput = analysis.cost_by_token_category.find(
    (row) => row.category === 'input_tokens',
  )

  return (
    <div className="app">
      <header>
        <div className="masthead">
          <h1>TokenLens</h1>
          <span className="provenance">
            rate table v{rate_table.version} · {rate_table.updated} ·{' '}
            {rate_table.currency}
          </span>
        </div>
        <p className="tagline">
          Observability tools report what you spent. This estimates what you should have
          spent and scores the gap, measured against real Claude Code history.
        </p>
      </header>

      {analysis.snapshot?.static && (
        <div className="notice" style={{ marginBottom: 4 }}>
          <h3>Frozen snapshot</h3>
          <p>
            These are real figures from one developer's Claude Code history, captured{' '}
            {new Date(analysis.generated_at).toLocaleDateString()}. There is no backend
            here — analysis reads local session logs, which exist only on the machine
            that produced them.
            {analysis.snapshot.prompts_redacted &&
              ' Prompt text is redacted; every figure is unmodified.'}{' '}
            Run it against your own logs from{' '}
            <a href="https://github.com/utkarshpatil02/tokenlens">the repository</a>.
          </p>
        </div>
      )}

      <section>
        <div className="section-head">
          <h2>Overview</h2>
        </div>
        <Overview data={overview} />
      </section>

      <section>
        <div className="section-head">
          <h2>Where the money went</h2>
          {uncachedInput && (
            <span className="section-note">
              uncached input is only {usd(uncachedInput.cost)} — cost is carried by cache
              traffic
            </span>
          )}
        </div>
        <CostBreakdown
          byCategory={analysis.cost_by_token_category}
          byModel={analysis.cost_by_model}
        />
      </section>

      <section>
        <div className="section-head">
          <h2>Turn shape</h2>
        </div>
        <CallsPerTurn rows={analysis.calls_per_turn} />
      </section>

      {waste ? (
        <>
          <section>
            <div className="section-head">
              <h2>Waste</h2>
              <span className="section-note">
                {waste.scored_turns} of {overview.scorable_turns} turns scored
                {unclassified > 0 && ` · ${unclassified} not yet classified`}
              </span>
            </div>
            <WasteSummary waste={waste} />
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
      ) : (
        <section>
          <div className="section-head">
            <h2>Waste</h2>
          </div>
          <div className="notice">
            <h3>Not measured yet</h3>
            <p>
              Waste scoring needs prompts classified by task complexity, which is the
              only step that costs money. {overview.scorable_turns} prompts are ready.
              Everything above needs none of it and is already complete.
            </p>
            {health?.has_api_key ? (
              <button onClick={() => void classify()} disabled={classifying}>
                {classifying
                  ? 'Classifying…'
                  : `Classify ${overview.scorable_turns} prompts`}
              </button>
            ) : (
              <p>
                Set <code>ANTHROPIC_API_KEY</code> and restart the API server to enable
                this.
              </p>
            )}
            {error && <p style={{ color: 'var(--crit)' }}>{error}</p>}
          </div>
        </section>
      )}
    </div>
  )
}
