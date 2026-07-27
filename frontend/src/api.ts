import type { Analysis, Health } from './types'

/**
 * Backend calls.
 *
 * Relative URLs throughout — Vite proxies /api in dev, and a deployed build is
 * served from the same origin, so there is no base URL to configure.
 */

const parse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    // FastAPI puts the useful message in `detail`; surface it rather than a
    // bare status code, since the actionable errors here are configuration
    // problems the user can fix.
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

export const fetchAnalysis = (): Promise<Analysis> =>
  fetch('/api/analysis').then(parse<Analysis>)

export const fetchHealth = (): Promise<Health> =>
  fetch('/api/health').then(parse<Health>)

/** Billable: classifies any uncached prompts. */
export const runClassification = (): Promise<Analysis> =>
  fetch('/api/classify', { method: 'POST' }).then(parse<Analysis>)
