import type { ReactNode } from 'react'

interface Props {
  value: ReactNode
  label: ReactNode
  sub?: ReactNode
}

/** One headline figure: the number, what it is, and its qualifier. */
export function StatCard({ value, label, sub }: Props) {
  return (
    <div className="panel stat">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  )
}
