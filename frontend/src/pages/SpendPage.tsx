import { CallsPerTurn, CostBreakdown } from '../components/CostBreakdown'
import { SectionHead } from '../components/ui/SectionHead'
import { usd } from '../format'
import type { UploadSession } from '../session'

/** Where the money went, and the turn shape that explains why. */
export function SpendPage({ session }: { session: UploadSession }) {
  const { analysis } = session
  if (!analysis) return null

  const uncachedInput = analysis.cost_by_token_category.find(
    (row) => row.category === 'input_tokens',
  )
  const cacheRead = analysis.cost_by_token_category.find(
    (row) => row.category === 'cache_read',
  )
  // Only worth saying when it is true of this file. On a single-shot export with
  // no cache traffic the same sentence would be actively misleading.
  const cacheDominates = (cacheRead?.share ?? 0) > 0.5 && uncachedInput !== undefined

  return (
    <>
      {analysis.cost_by_token_category.length > 0 && (
        <section>
          <SectionHead
            title="Where the money went"
            note={
              cacheDominates
                ? `uncached input is only ${usd(uncachedInput!.cost)} — cost is carried by cache traffic`
                : undefined
            }
          />
          <CostBreakdown
            byCategory={analysis.cost_by_token_category}
            byModel={analysis.cost_by_model}
          />
        </section>
      )}

      {analysis.calls_per_turn.length > 0 && (
        <section>
          <SectionHead
            title="Turn shape"
            note="how many API calls one prompt actually triggers"
          />
          <CallsPerTurn rows={analysis.calls_per_turn} />
        </section>
      )}
    </>
  )
}
