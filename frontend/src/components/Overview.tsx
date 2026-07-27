import type { Overview as OverviewData } from '../types'
import { compact, tokens, usd } from '../format'

interface Props {
  data: OverviewData
}

/** Headline figures. Cost leads, because the dollar figure is the claim. */
export function Overview({ data }: Props) {
  return (
    <div className="grid stats">
      <div className="panel stat">
        <div className="value">{usd(data.total_cost)}</div>
        <div className="label">total spend</div>
        <div className="sub">
          across {data.sessions} session{data.sessions === 1 ? '' : 's'}
        </div>
      </div>

      <div className="panel stat">
        <div className="value">{compact(data.calls)}</div>
        <div className="label">API requests</div>
        <div className="sub">{tokens(data.total_tokens)} tokens</div>
      </div>

      <div className="panel stat">
        <div className="value">{compact(data.turns)}</div>
        <div className="label">turns</div>
        <div className="sub">{data.scorable_turns} with prompt text</div>
      </div>

      <div className="panel stat">
        <div className="value">{data.mean_calls_per_turn}</div>
        <div className="label">mean calls / turn</div>
        <div className="sub">
          {data.mean_calls_per_turn > 1.5 ? 'agentic usage' : 'single-shot usage'}
        </div>
      </div>
    </div>
  )
}
