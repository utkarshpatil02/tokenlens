/**
 * The icon set.
 *
 * Hand-written rather than pulled from a library: eight glyphs do not justify a
 * dependency, and inlining them means no network request, no flash of missing
 * icon, and no sprite that can fall out of sync with the markup referencing it.
 *
 * Every icon here is used somewhere. An icon that only decorates is noise in a
 * dense table, so the rule is that it must either replace a word or mark a state
 * the copy already names.
 */

export type IconName =
  | 'upload'
  | 'file'
  | 'alert'
  | 'info'
  | 'lock'
  | 'copy'
  | 'check'
  | 'spinner'

/** 24x24 stroke paths, drawn on a common grid so weights match. */
const PATHS: Record<IconName, string> = {
  upload: 'M12 16V4m0 0L7 9m5-5 5 5M4 17v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1',
  file: 'M14 3H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7zm0 0v4h4',
  alert: 'M12 8v5m0 3h.01M10.3 3.9 2.4 17.1A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z',
  info: 'M12 16v-5m0-3h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z',
  copy: 'M9 9V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-4M5 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z',
  check: 'm4 12 5.5 5.5L20 7',
  spinner: 'M12 3a9 9 0 1 0 9 9',
}

interface Props {
  name: IconName
  /** Matches the surrounding text size by default. */
  size?: number
  className?: string
  /**
   * Only pass this when the icon is the sole carrier of the meaning. Beside a
   * word that already says it, the icon must stay hidden or a screen reader
   * announces the same thing twice.
   */
  label?: string
}

export function Icon({ name, size = 16, className, label }: Props) {
  return (
    <svg
      className={['icon', name === 'spinner' && 'icon-spin', className]
        .filter(Boolean)
        .join(' ')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
