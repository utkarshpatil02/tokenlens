import type { ModelRow, TokenCategoryRow } from '../types'
import { SERIES, TIER_LABEL, pct, tokens, usd } from '../format'

interface Props {
  byCategory: TokenCategoryRow[]
  byModel: ModelRow[]
}

/**
 * Where the money went.
 *
 * Horizontal bars rather than a pie: the shares here span three orders of
 * magnitude, and a pie cannot render a 0.0% slice legibly. The uncached-input
 * row matters precisely because it is near zero — it is the finding that made a
 * prompt-length-only cost model untenable — so it has to stay visible.
 */
export function CostBreakdown({ byCategory, byModel }: Props) {
  const maxCategoryShare = Math.max(...byCategory.map((r) => r.share), 0.01)
  const maxModelShare = Math.max(...byModel.map((r) => r.share), 0.01)

  return (
    <div className="grid panels-2">
      <div className="panel">
        <h3>By token category</h3>
        <div className="bars">
          {byCategory.map((row, i) => (
            <div className="bar-row" key={row.category}>
              <span className="name">{row.label}</span>
              <span className="track">
                <span
                  className="fill"
                  style={{
                    width: `${Math.max((row.share / maxCategoryShare) * 100, 0.6)}%`,
                    background: SERIES[i % SERIES.length],
                  }}
                />
              </span>
              <span className="amount">{usd(row.cost)}</span>
              <span className="meta">{tokens(row.tokens)}</span>
            </div>
          ))}
        </div>
        <div className="legend">
          <span>Bars scaled to the largest share, not to 100%</span>
        </div>
      </div>

      <div className="panel">
        <h3>By model</h3>
        <div className="bars">
          {byModel.map((row) => (
            <div className="bar-row" key={row.model}>
              <span className="name" title={row.model}>
                {row.model.replace('claude-', '')}
              </span>
              <span className="track">
                <span
                  className="fill"
                  style={{
                    width: `${Math.max((row.share / maxModelShare) * 100, 0.6)}%`,
                    background: SERIES[Math.min(3 - row.tier, SERIES.length - 1)],
                  }}
                />
              </span>
              <span className="amount">{usd(row.cost)}</span>
              <span className="meta">{pct(row.share)}</span>
            </div>
          ))}
        </div>
        <div className="legend">
          {byModel.map((row) => (
            <span key={row.model}>
              <span
                className="swatch"
                style={{ background: SERIES[Math.min(3 - row.tier, SERIES.length - 1)] }}
              />
              {TIER_LABEL[row.tier]} · {row.calls} calls
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Turn shape: how many API calls one prompt actually triggers. */
export function CallsPerTurn({ rows }: { rows: { calls: number; turns: number }[] }) {
  const maxTurns = Math.max(...rows.map((r) => r.turns), 1)
  const heaviest = rows.length ? rows[rows.length - 1] : null

  return (
    <div className="panel">
      <h3>Calls per turn</h3>
      <div className="bars">
        {rows.map((row) => (
          <div className="bar-row" key={row.calls}>
            <span className="name">
              {row.calls} call{row.calls === 1 ? '' : 's'}
            </span>
            <span className="track">
              <span
                className="fill"
                style={{
                  width: `${(row.turns / maxTurns) * 100}%`,
                  background: 'var(--c2)',
                }}
              />
            </span>
            <span className="amount">
              {row.turns} turn{row.turns === 1 ? '' : 's'}
            </span>
          </div>
        ))}
      </div>
      {heaviest && heaviest.calls > 1 && (
        <div className="legend">
          <span>
            One prompt drove up to {heaviest.calls} requests — why scoring happens per
            turn, not per call
          </span>
        </div>
      )}
    </div>
  )
}
