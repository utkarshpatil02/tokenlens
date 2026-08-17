import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { ROUTES } from '../router'
import type { Route } from '../router'
import type { Theme } from '../theme'
import { ThemeToggle } from './ThemeToggle'
import { Icon } from './ui/Icon'

interface NavItem {
  route: Route
  label: string
  /** Why the item is unavailable, shown instead of hiding it. */
  requiresFile?: boolean
}

interface NavGroup {
  heading: string
  items: NavItem[]
}

const GROUPS: NavGroup[] = [
  {
    heading: 'Analyze',
    items: [{ route: ROUTES.upload, label: 'Upload an export' }],
  },
  {
    heading: 'Your analysis',
    items: [
      { route: ROUTES.overview, label: 'Overview', requiresFile: true },
      { route: ROUTES.spend, label: 'Spend', requiresFile: true },
      { route: ROUTES.waste, label: 'Waste', requiresFile: true },
    ],
  },
  {
    heading: 'Reference',
    items: [{ route: ROUTES.demo, label: 'Demo dataset' }],
  },
]

interface Props {
  route: Route
  onNavigate: (to: string) => void
  hasFile: boolean
  fileName: string | null
  theme: Theme
  onTheme: (theme: Theme) => void
  children: ReactNode
}

/**
 * The application frame: navigation, current file, theme, and one view.
 *
 * Items under "Your analysis" are disabled rather than hidden before a file is
 * loaded. Hiding them would make the app look like it does less than it does,
 * and a first-time visitor would have no idea what uploading buys them.
 */
export function AppShell({
  route,
  onNavigate,
  hasFile,
  fileName,
  theme,
  onTheme,
  children,
}: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false)

  // A drawer that survives the navigation it triggered covers the page it just
  // moved to.
  useEffect(() => {
    setDrawerOpen(false)
  }, [route])

  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  const go = (to: string, enabled: boolean) => {
    if (enabled) onNavigate(to)
  }

  return (
    <div className={`shell${drawerOpen ? ' drawer-open' : ''}`}>
      <header className="topbar">
        <button
          type="button"
          className="ghost drawer-toggle"
          aria-expanded={drawerOpen}
          aria-controls="app-nav"
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <span className="drawer-bars" aria-hidden="true" />
          <span className="sr-only">Menu</span>
        </button>
        <span className="topbar-brand">TokenLens</span>
        {fileName && (
          <span className="topbar-file" title={fileName}>
            <Icon name="file" size={13} />
            {fileName}
          </span>
        )}
      </header>

      {/* Click-away for the drawer. Inert and invisible on desktop. */}
      <div
        className="drawer-scrim"
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />

      <nav className="sidebar" id="app-nav" aria-label="Sections">
        <div className="sidebar-brand">
          <span className="sidebar-mark" aria-hidden="true" />
          TokenLens
        </div>

        <div className="sidebar-scroll">
          {GROUPS.map((group) => (
            <div className="nav-group" key={group.heading}>
              <div className="nav-heading">{group.heading}</div>
              {group.items.map((item) => {
                const enabled = !item.requiresFile || hasFile
                const active = route === item.route
                return (
                  <button
                    key={item.route}
                    type="button"
                    className={`nav-item${active ? ' active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    disabled={!enabled}
                    title={enabled ? undefined : 'Upload an export first'}
                    onClick={() => go(item.route, enabled)}
                  >
                    {item.label}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        <div className="sidebar-foot">
          <ThemeToggle theme={theme} onChange={onTheme} />
        </div>
      </nav>

      <main className="content">{children}</main>
    </div>
  )
}
