import { useCallback, useEffect, useState } from 'react'

/**
 * Three-state theme: light, dark, or follow the OS.
 *
 * "System" is the default and is a real third state, not a synonym for one of
 * the other two. Collapsing it to a boolean loses the ability to follow a
 * machine that switches at sunset, which is the behaviour most people have
 * already configured and would rather not configure twice.
 *
 * An explicit choice is written to `localStorage` — unlike an API key, a colour
 * preference is exactly the kind of thing that should outlive the tab.
 */

export type Theme = 'light' | 'dark' | 'system'

const KEY = 'tokenlens:theme'

const isTheme = (value: unknown): value is Theme =>
  value === 'light' || value === 'dark' || value === 'system'

const read = (): Theme => {
  try {
    const stored = localStorage.getItem(KEY)
    return isTheme(stored) ? stored : 'system'
  } catch {
    // Private browsing can throw on access. Following the OS is the right
    // fallback; a blank screen is not.
    return 'system'
  }
}

/**
 * Applied as an attribute rather than a class so the CSS can express all three
 * states: `[data-theme]` wins where set, and its absence lets the
 * `prefers-color-scheme` media query decide.
 */
const apply = (theme: Theme) => {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(read)

  useEffect(() => {
    apply(theme)
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    try {
      if (next === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, next)
    } catch {
      /* The choice still applies for this visit; it just will not be remembered. */
    }
  }, [])

  return { theme, setTheme }
}
