import type { LeaderboardRow } from '../types'
import { compact, truncate, usd } from '../format'

/**
 * Worst turns by dollar waste.
 *
 * Every row shows its component split, the classifier's own rationale, and a
 * concrete recommendation. A leaderboard that ranks without explaining is just
 * an accusation — the point is that each number can be traced to a stated reason.
 */
export function Leaderboard({ rows }: { rows: LeaderboardRow[] }) {
  if (!rows.length) {
    return (
      <div className="panel">
        <p style={{ margin: 0, color: 'var(--muted)' }}>No scored turns yet.</p>
      </div>
    )
  }

  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            <th>Prompt</th>
            <th>Classified</th>
            <th className="num">Tiers</th>
            <th className="num">Calls</th>
            <th className="num">Spent</th>
            <th className="num">Waste</th>
            <th>Recommendation</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.turn_id}>
              <td className="prompt-cell">
                <div>{truncate(row.prompt ?? '(no prompt text)')}</div>
                <div className="rationale">{row.rationale}</div>
              </td>
              <td>
                <span className="pill">{row.category}</span>{' '}
                <span className="pill">{row.complexity}</span>
                <div className="rationale">
                  confidence {row.confidence.toFixed(2)}
                  {row.escalated && ' · escalated'}
                </div>
              </td>
              <td className="num">
                {row.tier_used} / {row.tier_required}
                {row.under_provisioned && (
                  <div className="rationale">under-provisioned</div>
                )}
              </td>
              <td className="num">{row.calls}</td>
              <td className="num">{usd(row.actual_cost)}</td>
              <td className="num">
                <strong>{usd(row.estimated_waste)}</strong>
                <div className="rationale">
                  <span className={`pill band-${row.band}`}>{row.normalized}</span>
                </div>
              </td>
              <td style={{ minWidth: 190 }}>
                {row.recommendation}
                {row.excess_tokens > 0 && (
                  <div className="rationale">
                    overshoot {usd(row.overshoot)} · bloat {usd(row.bloat)} (
                    {compact(row.excess_tokens)} excess tokens)
                  </div>
                )}
                {!row.bloat_measured && (
                  <div className="rationale">bloat not measured: baseline too thin</div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
