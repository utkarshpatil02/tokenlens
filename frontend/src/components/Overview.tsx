import type { Overview as OverviewData } from '../types'
import { compact, tokens, usd } from '../format'
import { StatCard } from './ui/StatCard'

interface Props {
  data: OverviewData
}

/** Headline figures. Cost leads, because the dollar figure is the claim. */
export function Overview({ data }: Props) {
  return (
    <div className="grid stats">
      <StatCard
        value={usd(data.total_cost)}
        label="total spend"
        /* An uploaded export often carries no session column at all, and
           "across 0 sessions" reads as a bug rather than as absent data. */
        sub={
          data.sessions > 0
            ? `across ${data.sessions} session${data.sessions === 1 ? '' : 's'}`
            : 'no session ids in this source'
        }
      />
      <StatCard
        value={compact(data.calls)}
        label="API requests"
        sub={`${tokens(data.total_tokens)} tokens`}
      />
      <StatCard
        value={compact(data.turns)}
        label="turns"
        sub={`${data.scorable_turns} with prompt text`}
      />
      <StatCard
        value={data.mean_calls_per_turn}
        label="mean calls / turn"
        sub={data.mean_calls_per_turn > 1.5 ? 'agentic usage' : 'single-shot usage'}
      />
    </div>
  )
}
