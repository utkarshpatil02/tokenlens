import type { ReactNode } from 'react'

import { Icon } from './Icon'

type Tone = 'info' | 'error'

interface Props {
  title: ReactNode
  tone?: Tone
  children?: ReactNode
  /** Buttons for the notice, laid out consistently rather than per caller. */
  actions?: ReactNode
  className?: string
}

/**
 * A bordered callout with a heading.
 *
 * This markup was hand-rolled in seven places, each with its own inline margin,
 * which is how the spacing between a notice and the thing above it came to
 * differ depending on which screen you were on.
 *
 * The error tone is announced: a failed upload or a dead API key replaces
 * content the reader was waiting for, and silently swapping it leaves anyone not
 * looking at that region with no idea it changed.
 */
export function Notice({ title, tone = 'info', children, actions, className }: Props) {
  const isError = tone === 'error'
  return (
    <div
      className={['notice', isError && 'error', className].filter(Boolean).join(' ')}
      role={isError ? 'alert' : undefined}
    >
      <h3>
        <Icon name={isError ? 'alert' : 'info'} className="notice-icon" />
        {title}
      </h3>
      {children}
      {actions && <div className="notice-actions">{actions}</div>}
    </div>
  )
}
