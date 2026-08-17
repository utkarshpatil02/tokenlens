import { ClassifyPanel } from '../components/ClassifyPanel'
import { LabelingPanel } from '../components/LabelingPanel'
import { Leaderboard } from '../components/Leaderboard'
import { Heatmap, WasteSummary } from '../components/WastePanel'
import { Button } from '../components/ui/Button'
import { Notice } from '../components/ui/Notice'
import { SectionHead } from '../components/ui/SectionHead'
import { labelProgress, spendCoveredBy } from '../engine/labeling'
import { formatMoney } from '../engine/money'
import { pct, usd } from '../format'
import { WASTE_TABS } from '../router'
import type { WasteTab } from '../router'
import type { UploadSession } from '../session'

/**
 * The size of pass worth quoting up front.
 *
 * Ten turns took 45% of the reference corpus's spend. The figure shown is always
 * computed from the file in hand, never borrowed — a flat export genuinely does
 * not have that shape, and promising it would be the wrong kind of confident.
 */
const SHORT_PASS = 10

const TAB_LABEL: Record<WasteTab, string> = {
  summary: 'Summary',
  matrix: 'Complexity × tier',
  leaderboard: 'Leaderboard',
}

interface Props {
  session: UploadSession
  tab: WasteTab
  onNavigate: (to: string) => void
}

/**
 * Waste: unmeasured, being measured, or measured.
 *
 * The unmeasured state is deliberately not zeros. Nothing here claims a file has
 * no waste until enough of its spend has actually been judged, and the scored
 * figures always say how much of the file they cover.
 */
export function WastePage({ session, tab, onNavigate }: Props) {
  const { analysis, queue, labels, classifications, mode } = session
  if (!analysis || !queue) return null

  const { waste, overview } = analysis
  const progress = labelProgress(queue, labels)
  const close = () => session.setMode('none')

  // Judged by any means, not just by hand — what the classifier covered counts
  // toward the same total and must not be re-bought.
  const judged = queue.tasks.filter((task) =>
    classifications.has(task.turn.turn_id),
  ).length

  if (mode === 'labelling') {
    return (
      <>
        <SectionHead
          title="Label prompts"
          note={`${pct(progress.spendShare)} of labellable spend judged by hand`}
        />
        <LabelingPanel
          queue={queue}
          labels={labels}
          onChange={session.setLabels}
          onDone={close}
          onCancel={close}
        />
      </>
    )
  }

  if (mode === 'classifying') {
    return (
      <>
        <SectionHead title="Classify with a model" />
        <ClassifyPanel
          queue={queue}
          existing={classifications}
          onClassified={session.addClassified}
          onClose={close}
        />
      </>
    )
  }

  if (!waste) {
    return (
      <>
        <SectionHead title="Waste" />
        <Notice
          title="Not measured yet"
          actions={
            <>
              <Button
                variant="primary"
                onClick={() => session.setMode('labelling')}
                disabled={queue.tasks.length === 0}
              >
                Label {queue.tasks.length} prompt{queue.tasks.length === 1 ? '' : 's'}{' '}
                yourself
              </Button>
              <Button
                onClick={() => session.setMode('classifying')}
                disabled={queue.tasks.length === 0}
              >
                Classify with a model
              </Button>
            </>
          }
        >
          <p className="measure">
            Scoring the gap between what this file cost and what it should have cost
            needs each prompt judged for task complexity — the only input the spend
            figures cannot supply. {queue.tasks.length} of {overview.turns} turns here
            carry prompt text.
            {/* Only a claim when there is something to concentrate. Below a short
                pass the "top ten cover most of it" line reduces to "all of them
                cover all of it", which is true and worth nobody's attention. */}
            {queue.tasks.length > SHORT_PASS &&
              ` They are ordered most expensive first, and the top ${SHORT_PASS}` +
                ` alone carry ${pct(spendCoveredBy(queue, SHORT_PASS))} of their spend.`}
          </p>
          <p className="section-note measure">
            Labelling costs nothing and needs no key. Claude and Gemini need a key from
            that provider; the screen quotes what a run will cost before spending
            anything.
          </p>
          {queue.tasks.length === 0 && (
            <p>
              No row in this file carried prompt text, so there is nothing to judge. Map
              a prompt column and analyze again if the export has one.
            </p>
          )}
        </Notice>
      </>
    )
  }

  return (
    <>
      <SectionHead
        title="Waste"
        note={`${judged} of ${progress.total} prompts judged · ${pct(
          progress.fileShare,
        )} of the file's spend scored`}
      />

      <div className="tabs" role="tablist" aria-label="Waste views">
        {WASTE_TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={`tab${tab === name ? ' active' : ''}`}
            onClick={() => onNavigate(`/waste/${name}`)}
          >
            {TAB_LABEL[name]}
          </button>
        ))}
      </div>

      {tab === 'summary' && (
        <>
          <WasteSummary waste={waste} />
          {judged < progress.total && (
            <Notice
              title="Partial by design, and it says so"
              className="stack"
              actions={
                <>
                  <Button onClick={() => session.setMode('labelling')}>
                    Label {progress.total - judged} more
                  </Button>
                  <Button onClick={() => session.setMode('classifying')}>
                    Classify the rest with a model
                  </Button>
                </>
              }
            >
              <p>
                These figures cover the {judged} turn{judged === 1 ? '' : 's'} judged so
                far — {usd(waste.scored_cost)} of {usd(formatMoney(progress.queueCost))}{' '}
                labellable spend. The rest are not counted as waste-free; they are not
                counted at all.
              </p>
            </Notice>
          )}
        </>
      )}

      {tab === 'matrix' && <Heatmap waste={waste} />}

      {tab === 'leaderboard' && <Leaderboard rows={waste.leaderboard} />}
    </>
  )
}
