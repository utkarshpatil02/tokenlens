import { useCallback, useEffect, useState } from 'react'

/**
 * A hash router, hand-written.
 *
 * Hash rather than history for one concrete reason: this deploys to GitHub
 * Pages under `/tokenlens/`. A history router there needs both a `basename` and
 * a `404.html` copy of `index.html`, or every deep link 404s on refresh — a
 * failure that only shows up in production, which is the worst place to find it.
 * The fragment never reaches the server, so `#/waste` is simply always served
 * by `index.html`.
 *
 * Fifty lines is also less than the dependency would cost, and this app has
 * six destinations rather than sixty.
 */

export const ROUTES = {
  upload: '/',
  overview: '/overview',
  spend: '/spend',
  waste: '/waste',
  demo: '/demo',
} as const

export type Route = (typeof ROUTES)[keyof typeof ROUTES]

/** Sub-views within Waste. Kept in the hash so a deep link lands correctly. */
export const WASTE_TABS = ['summary', 'matrix', 'leaderboard'] as const
export type WasteTab = (typeof WASTE_TABS)[number]

const read = (): string => {
  const raw = window.location.hash.replace(/^#/, '')
  return raw.startsWith('/') ? raw : '/'
}

export function useHashRoute() {
  const [path, setPath] = useState(read)

  useEffect(() => {
    const onChange = () => setPath(read())
    window.addEventListener('hashchange', onChange)
    // The hash can already be set on first load from a shared link.
    onChange()
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const navigate = useCallback((to: string) => {
    window.location.hash = to
    // Landing mid-page after following a nav link reads as a broken layout.
    window.scrollTo({ top: 0 })
  }, [])

  // `/waste/leaderboard` -> base `/waste`, tab `leaderboard`.
  const [, head = '', tail = ''] = path.split('/')
  const base = `/${head}` as Route
  const known = Object.values(ROUTES).includes(base) ? base : ROUTES.upload
  const tab = (WASTE_TABS as readonly string[]).includes(tail)
    ? (tail as WasteTab)
    : WASTE_TABS[0]

  return { path, route: known, tab, navigate }
}
