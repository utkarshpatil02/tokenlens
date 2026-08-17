import { Overview } from '../components/Overview'
import { Button } from '../components/ui/Button'
import { Notice } from '../components/ui/Notice'
import { SectionHead } from '../components/ui/SectionHead'
import { ROUTES } from '../router'
import type { UploadSession } from '../session'

interface Props {
  session: UploadSession
  onNavigate: (to: string) => void
}

/** Headline figures for the uploaded file, plus what the file gave up badly. */
export function OverviewPage({ session, onNavigate }: Props) {
  const { report, analysis } = session
  if (!report || !analysis) return null

  const { stats, issues, unmappedColumns } = report.ingest
  const { droppedCalls, droppedModels } = report
  const hasFindings =
    stats.skipped > 0 ||
    stats.duplicates > 0 ||
    stats.missingTimestamps > 0 ||
    droppedModels.length > 0 ||
    unmappedColumns.length > 0

  return (
    <>
      <SectionHead
        title="Overview"
        note={
          report.ingest.profile === 'agentic'
            ? 'agentic — calls grouped under the prompt that caused them'
            : 'single-shot — one call per turn'
        }
      />
      <Overview data={analysis.overview} />

      {!analysis.waste && (
        <Notice
          title="Waste is not measured yet"
          className="stack"
          actions={
            <Button variant="primary" onClick={() => onNavigate(ROUTES.waste)}>
              Score the waste
            </Button>
          }
        >
          <p className="measure">
            The figures above are what the file cost. Scoring the gap between that
            and what it should have cost needs each prompt judged for task
            complexity — the only input these numbers cannot supply.
          </p>
        </Notice>
      )}

      {hasFindings && (
        <section>
          <SectionHead title="What the file did not cleanly give up" />
          <Notice title="Rows this file could not fully account for">
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
          </Notice>
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
    </>
  )
}
