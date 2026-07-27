import type { Analysis, Health } from './types'

/**
 * Backend calls.
 *
 * Relative URLs throughout — Vite proxies /api in dev, and a deployed build is
 * served from the same origin, so there is no base URL to configure.
 *
 * The static deploy has no backend at all: `~/.claude/projects` exists only on
 * the machine that produced the logs. So when the API is unreachable the app
 * falls back to a frozen snapshot bundled with the build, and says so rather
 * than presenting stale figures as live ones.
 */

const parse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    // FastAPI puts the useful message in `detail`; surface it rather than a bare
    // status code, since the actionable failures here are configuration problems.
    let detail = `Request failed (${response.status})`
    try {
      const body = await response.json()
      if (body?.detail) detail = body.detail
    } catch {
      /* non-JSON error body; keep the status message */
    }
    throw new Error(detail)
  }
  return response.json() as Promise<T>
}

/** `import.meta.env.BASE_URL` keeps this correct under a project subpath. */
const snapshotUrl = `${import.meta.env.BASE_URL}snapshot.json`

export const fetchAnalysis = async (): Promise<Analysis> => {
  try {
    return await fetch('/api/analysis').then(parse<Analysis>)
  } catch {
    // No live backend — fall back to the bundled snapshot. If that is missing
    // too, the error propagates and the UI reports it.
    return fetch(snapshotUrl).then(parse<Analysis>)
  }
}

export const fetchHealth = async (): Promise<Health | null> => {
  try {
    return await fetch('/api/health').then(parse<Health>)
  } catch {
    // Static deploy: there is no server to report readiness.
    return null
  }
}

/** Billable: classifies any uncached prompts. Live backend only. */
export const runClassification = (): Promise<Analysis> =>
  fetch('/api/classify', { method: 'POST' }).then(parse<Analysis>)
