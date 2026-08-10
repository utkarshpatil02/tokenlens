import type { Waste } from '../types'
import { BAND_COLOR, money, pct, usd } from '../format'

const COMPLEXITY_ORDER = ['trivial', 'moderate', 'complex']
const TIERS = [1, 2, 3]

/** Waste summary: the dollar figure, then its component split. */
export function WasteSummary({ waste }: { waste: Waste }) {
  const { components } = waste
  return (
    <>
      <div className="grid stats">
        <div className="panel stat">
          <div className="value">{usd(waste.total_waste)}</div>
          <div className="label">estimated waste</div>
          <div className="sub">{pct(waste.waste_share)} of scored spend</div>
        </div>
        <div className="panel stat">
          <div className="value">{usd(components.overshoot)}</div>
          <div className="label">model overshoot</div>
          <div className="sub">a more capable model than needed</div>
        </div>
        <div className="panel stat">
          <div className="value">{usd(components.bloat)}</div>
          <div className="label">context bloat</div>
          <div className="sub">
            {waste.unmeasured_bloat_turns > 0
              ? `${waste.unmeasured_bloat_turns} turns lacked a baseline`
              : 'tokens beyond comparable work'}
          </div>
        </div>
        <div className="panel stat">
          <div className="value">{usd(components.zero_value_cost)}</div>
          <div className="label">zero-value spend</div>
          <div className="sub">
            {waste.flags.zero_value} busywork turn{waste.flags.zero_value === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 10 }}>
        <h3>Waste bands</h3>
        <div className="bars">
          {waste.bands.map((band) => (
            <div className="bar-row" key={band.band}>
              <span className="name">{band.band}</span>
              <span className="track">
                <span
                  className="fill"
                  style={{
                    width: `${(band.turns / Math.max(waste.scored_turns, 1)) * 100}%`,
                    background: BAND_COLOR[band.band],
                  }}
                />
              </span>
              <span className="amount">
                {band.turns} turn{band.turns === 1 ? '' : 's'}
              </span>
              <span className="meta">{usd(band.cost)}</span>
            </div>
          ))}
        </div>
      </div>

      <Provenance waste={waste} />
    </>
  )
}

/**
 * Who produced the labels these figures rest on.
 *
 * Publishing a number whose origin cannot be traced is the one thing this
 * project is careful never to do, so this is a panel rather than a footnote.
 * Model ids are printed raw: `claude-haiku-4-5` is traceable to a rate-table
 * row and a request, and a friendlier "Haiku 4.5" is one rename away from being
 * ambiguous about which model actually answered.
 */
export function Provenance({ waste }: { waste: Waste }) {
  const { source, flags } = waste
  const { models, human_turns: humanTurns } = source

  return (
    <div className="panel provenance-panel" style={{ marginTop: 10 }}>
      <h3>Where these labels came from</h3>

      <p className="section-note" style={{ maxWidth: '74ch' }}>
        {source.kind === 'hand-labelled' && (
          <>
            Scored from hand labels, not classifier predictions — so these figures say
            nothing about classifier accuracy.
          </>
        )}
        {source.kind === 'classifier' && models.length === 0 && (
          <>Scored from classifier output.</>
        )}
        {source.kind === 'classifier' && models.length > 0 && (
          <>
            Scored from labels produced by{' '}
            {models.length === 1 ? 'one model' : `${models.length} models`}, listed
            below. No human judgement is mixed in, so these figures can be compared
            against a reference set.
          </>
        )}
        {source.kind === 'mixed' && (
          <>
            Scored from a <strong>mix</strong> of hand labels and classifier output
            {humanTurns !== undefined && <> — {humanTurns} judged by a person</>}. A
            mixed score is not a measurement of any one classifier, and the hand-labelled
            turns cannot be used to score the models that labelled the rest.
          </>
        )}
      </p>

      {models.length > 0 && (
        <ul className="source-models">
          {models.map((entry) => (
            <li key={entry.model}>
              <code>{entry.model}</code>
              <span className="source-turns">
                {entry.turns} turn{entry.turns === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {flags.escalated > 0 && (
        <p className="section-note" style={{ maxWidth: '74ch' }}>
          {flags.escalated} prompt{flags.escalated === 1 ? '' : 's'} escalated to a
          stronger model; {flags.escalation_changed_tier} of those changed the required
          tier — the rest confirmed the first answer.
        </p>
      )}
    </div>
  )
}

/**
 * Complexity against the tier actually used.
 *
 * Cells above the diagonal are overshoot — a task that needed a cheap model run
 * on an expensive one. That corner is the money.
 */
export function Heatmap({ waste }: { waste: Waste }) {
  const lookup = new Map(
    waste.complexity_by_tier.map((c) => [`${c.complexity}:${c.tier_used}`, c]),
  )
  const maxWaste = Math.max(
    ...waste.complexity_by_tier.map((c) => money(c.waste)),
    0.000001,
  )

  return (
    <div className="panel">
      <h3>Task complexity vs. model tier used</h3>
      <div className="scroll-x" style={{ border: 'none' }}>
        <table className="heatmap">
          <thead>
            <tr>
              <th />
              {TIERS.map((tier) => (
                <th key={tier} className="num">
                  tier {tier} used
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPLEXITY_ORDER.map((complexity, rowIndex) => (
              <tr key={complexity}>
                <th>{complexity}</th>
                {TIERS.map((tier) => {
                  const cell = lookup.get(`${complexity}:${tier}`)
                  const isOvershoot = tier > rowIndex + 1
                  if (!cell) {
                    return (
                      <td key={tier} className="empty">
                        –
                      </td>
                    )
                  }
                  const intensity = money(cell.waste) / maxWaste
                  return (
                    <td
                      key={tier}
                      className={isOvershoot ? 'overshoot' : undefined}
                      style={{
                        background:
                          intensity > 0
                            ? `color-mix(in srgb, var(--crit) ${Math.round(
                                intensity * 55,
                              )}%, var(--panel))`
                            : undefined,
                      }}
                      title={`${cell.turns} turns · ${usd(cell.cost)} spent · ${usd(
                        cell.waste,
                      )} waste`}
                    >
                      {cell.turns}
                      <span className="cell-cost">{usd(cell.cost)}</span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="legend">
        <span>
          <span
            className="swatch"
            style={{ border: '1px solid var(--crit)', background: 'transparent' }}
          />
          outlined = overshoot (tier used exceeded tier required)
        </span>
        <span>shading = waste concentration</span>
      </div>
    </div>
  )
}
