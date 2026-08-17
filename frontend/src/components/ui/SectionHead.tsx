import type { ReactNode } from 'react'

interface Props {
  title: string
  /** The qualifier that keeps a figure honest — coverage, scope, caveat. */
  note?: ReactNode
  /** Replaces the note styling entirely, for a badge or a control. */
  aside?: ReactNode
}

/**
 * A section heading and the caveat that belongs with it.
 *
 * The note is not decoration. Almost every figure in this app is partial —
 * scored over some turns and not others — and this is where that gets said, so
 * it is part of the heading component rather than left to each caller to
 * remember.
 */
export function SectionHead({ title, note, aside }: Props) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {aside ?? (note ? <span className="section-note">{note}</span> : null)}
    </div>
  )
}
