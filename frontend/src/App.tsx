import { useCallback, useEffect, useState } from 'react'

import { fetchAnalysis, fetchHealth, runClassification } from './api'
import { AppShell } from './components/AppShell'
import { Button } from './components/ui/Button'
import { Icon } from './components/ui/Icon'
import { Notice } from './components/ui/Notice'
import { DemoPage } from './pages/DemoPage'
import { OverviewPage } from './pages/OverviewPage'
import { SpendPage } from './pages/SpendPage'
import { UploadPage } from './pages/UploadPage'
import { WastePage } from './pages/WastePage'
import { ROUTES, useHashRoute } from './router'
import { useUploadSession } from './session'
import { useTheme } from './theme'
import type { Analysis, Health } from './types'

export default function App() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [classifying, setClassifying] = useState(false)

  const { route, tab, navigate } = useHashRoute()
  const { theme, setTheme } = useTheme()
  // Owned here, above the router, so navigating between pages cannot destroy a
  // parsed file, a hand label, or a classifier answer that was paid for.
  const session = useUploadSession()

  const load = useCallback(async () => {
    setError(null)
    try {
      const [data, status] = await Promise.all([fetchAnalysis(), fetchHealth()])
      setAnalysis(data)
      setHealth(status)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Billable, so it is only ever triggered by an explicit click.
  const classify = async () => {
    setClassifying(true)
    setError(null)
    try {
      setAnalysis(await runClassification())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setClassifying(false)
    }
  }

  // A route needing a file, reached without one — by a stale link or a reset.
  // Redirecting silently would leave no trace of why; saying so does.
  const needsFile =
    !session.hasFile &&
    (route === ROUTES.overview || route === ROUTES.spend || route === ROUTES.waste)

  const body = () => {
    if (needsFile) {
      return (
        <Notice
          title="No file loaded"
          actions={
            <Button variant="primary" onClick={() => navigate(ROUTES.upload)}>
              Upload an export
            </Button>
          }
        >
          <p className="measure">
            This page reads a file you have analysed in this tab. Nothing is stored
            between visits — that is the same property that keeps your export off any
            server — so a link to it will not carry the data with it.
          </p>
        </Notice>
      )
    }

    switch (route) {
      case ROUTES.overview:
        return <OverviewPage session={session} onNavigate={navigate} />
      case ROUTES.spend:
        return <SpendPage session={session} />
      case ROUTES.waste:
        return <WastePage session={session} tab={tab} onNavigate={navigate} />
      case ROUTES.demo:
        return analysis ? (
          <DemoPage
            analysis={analysis}
            health={health}
            error={error}
            classifying={classifying}
            onClassify={() => void classify()}
          />
        ) : error ? (
          <Notice
            title="Could not load the demo dataset"
            tone="error"
            actions={<Button onClick={() => void load()}>Retry</Button>}
          >
            <p>{error}</p>
            <p className="section-note measure">
              The upload path reads no backend and no snapshot, so it still works.
            </p>
          </Notice>
        ) : (
          <div className="center" role="status">
            <Icon name="spinner" /> Reading local session logs…
          </div>
        )
      default:
        return <UploadPage session={session} onNavigate={navigate} />
    }
  }

  return (
    <AppShell
      route={route}
      onNavigate={navigate}
      hasFile={session.hasFile}
      fileName={session.state.kind === 'ready' ? session.state.name : null}
      theme={theme}
      onTheme={setTheme}
    >
      {body()}
    </AppShell>
  )
}
