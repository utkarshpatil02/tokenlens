import type { ReactNode } from 'react'

interface Props {
  /** 0–1. Clamped, because a share computed from live totals can overshoot. */
  share: number
  /** Read out with the bar, so the percentage is not the only signal. */
  label: string
  children?: ReactNode
}

/**
 * A progress bar measured in spend, not in items.
 *
 * Both places this appears are counting dollars covered rather than prompts
 * done — that is the whole point of the cost-ordered queue — so the accessible
 * name has to carry the label, not just the number.
 */
export function Progress({ share, label, children }: Props) {
  const clamped = Math.min(Math.max(share, 0), 1)
  const percent = Math.round(clamped * 100)
  return (
    <div className="labeler-progress">
      <div
        className="labeler-track"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <span className="labeler-fill" style={{ width: `${clamped * 100}%` }} />
      </div>
      {children && <div className="labeler-progress-meta">{children}</div>}
    </div>
  )
}
