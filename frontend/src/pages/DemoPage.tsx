import { useState } from 'react'

import { CallsPerTurn, CostBreakdown } from '../components/CostBreakdown'
import { Leaderboard } from '../components/Leaderboard'
import { Overview } from '../components/Overview'
import { Heatmap, WasteSummary } from '../components/WastePanel'
import { Button } from '../components/ui/Button'
import { Notice } from '../components/ui/Notice'
import { SectionHead } from '../components/ui/SectionHead'
import { usd } from '../format'
import type { Analysis, Health } from '../types'

const VIEWS = ['overview', 'spend', 'waste'] as const
type View = (typeof VIEWS)[number]

const VIEW_LABEL: Record<View, string> = {
  overview: 'Overview',
  spend: 'Spend',
  waste: 'Waste',
}

interface Props {
  analysis: Analysis
  health: Health | null
  error: string | null
  classifying: boolean
  onClassify: () => void
}

/**
 * The reference dataset, on its own page.
 *
 * This used to sit directly beneath the uploaded file's figures in one scroll,
 * which meant "Where the money went", "Turn shape" and "Waste" each appeared
 * twice with nothing but a notice between them. Someone reading quickly could
 * take a stranger's $271.10 for their own number. Separate destinations make
 * that mistake impossible rather than merely unlikely.
 */
export function DemoPage({ analysis, health, error, classifying, onClassify }: Props) {
  const [view, setView] = useState<View>('overview')
  const { overview, waste } = analysis
  const unclassified = overview.scorable_turns - overview.classified_turns
  const uncachedInput = analysis.cost_by_token_category.find(
    (row) => row.category === 'input_tokens',
  )

  return (
    <>
      <SectionHead title="Demo dataset" note="not your data — a frozen reference" />

      {analysis.snapshot?.static && (
        <Notice title="Frozen snapshot">
          <p className="measure-wide">
            Real figures from one developer's Claude Code history, captured{' '}
            {new Date(analysis.generated_at).toLocaleDateString()}. There is no backend
            here — analysis reads local session logs, which exist only on the machine
            that produced them.
            {analysis.snapshot.prompts_redacted &&
              ' Prompt text is redacted; every figure is unmodified.'}{' '}
            Run it against your own logs from{' '}
            <a href="https://github.com/utkarshpatil02/tokenlens">the repository</a>.
          </p>
        </Notice>
      )}

      <div className="tabs" role="tablist" aria-label="Demo views">
        {VIEWS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={view === name}
            className={`tab${view === name ? ' active' : ''}`}
            onClick={() => setView(name)}
          >
            {VIEW_LABEL[name]}
          </button>
        ))}
      </div>

      {view === 'overview' && <Overview data={overview} />}

      {view === 'spend' && (
        <>
          <section>
            <SectionHead
              title="Where the money went"
              note={
                uncachedInput
                  ? `uncached input is only ${usd(uncachedInput.cost)} — cost is carried by cache traffic`
                  : undefined
              }
            />
            <CostBreakdown
              byCategory={analysis.cost_by_token_category}
              byModel={analysis.cost_by_model}
            />
          </section>
          <section>
            <SectionHead title="Turn shape" />
            <CallsPerTurn rows={analysis.calls_per_turn} />
          </section>
        </>
      )}

      {view === 'waste' &&
        (waste ? (
          <>
            <SectionHead
              title="Waste"
              note={`${waste.scored_turns} of ${overview.scorable_turns} turns scored${
                unclassified > 0 ? ` · ${unclassified} not yet classified` : ''
              }`}
            />
            <WasteSummary waste={waste} />
            <section>
              <SectionHead title="Complexity vs. tier" />
              <Heatmap waste={waste} />
            </section>
            <section>
              <SectionHead
                title="Waste leaderboard"
                note="worst turns by estimated dollar waste"
              />
              <Leaderboard rows={waste.leaderboard} />
            </section>
          </>
        ) : (
          <Notice
            title="Not measured yet"
            actions={
              health?.has_api_key ? (
                <Button onClick={onClassify} busy={classifying}>
                  {classifying
                    ? 'Classifying…'
                    : `Classify ${overview.scorable_turns} prompts`}
                </Button>
              ) : undefined
            }
          >
            <p className="measure">
              Waste scoring needs prompts classified by task complexity, which is the
              only step that costs money. {overview.scorable_turns} prompts are ready.
            </p>
            {!health?.has_api_key && (
              <p>
                Set <code>ANTHROPIC_API_KEY</code> and restart the API server to enable
                this.
              </p>
            )}
            {error && <p className="text-crit">{error}</p>}
          </Notice>
        ))}
    </>
  )
}
