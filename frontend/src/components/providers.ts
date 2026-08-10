/**
 * The classification modes the screen offers.
 *
 * This registry is the seam that keeps `ClassifyPanel` provider-agnostic:
 * adding a provider is an entry here plus an adapter, not a second panel. The
 * UI-facing copy lives at this layer rather than in `engine/`, so the engine
 * stays free of anything that only matters on screen.
 */

import { createClaudeBackend } from '../engine/claude'
import type { ClassifierBackend } from '../engine/classifier'
import { createGeminiBackend } from '../engine/gemini'

export interface Provider {
  /** Matches `ClassifierBackend.id`, and the value labels get attributed to. */
  id: string
  name: string
  /** One line under the heading: what runs, and what it costs. */
  blurb: string
  /** Where to get a key, so nobody has to go hunting. */
  keyUrl: string
  keyUrlLabel: string
  keyPlaceholder: string
  /** The caveat worth knowing before typing a key in. */
  keyHelp: string
  create: (key: string) => ClassifierBackend
}

export const PROVIDERS: Provider[] = [
  {
    id: 'claude',
    name: 'Claude',
    blurb:
      'Haiku 4.5 reads each prompt, escalating to Sonnet 5 only where it is unsure. Costs cents.',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyUrlLabel: 'console.anthropic.com',
    keyPlaceholder: 'sk-ant-…',
    keyHelp:
      'There is no free API tier, and a Claude.ai Pro or Max subscription does not authenticate against the API — this needs a key with billing set up.',
    create: (key) => createClaudeBackend(key),
  },
  {
    id: 'gemini',
    name: 'Gemini',
    blurb:
      '3.5 Flash-Lite reads each prompt, escalating to 3.5 Flash. Free within Google’s rate limits.',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyUrlLabel: 'aistudio.google.com',
    keyPlaceholder: 'AIza…',
    keyHelp:
      'Free-tier limits are low and Google does not publish them — rate-limited requests are retried with backoff, so a long run is slow rather than broken. A key on a paid tier bills per token, and this page cannot tell which yours is.',
    create: (key) => createGeminiBackend(key),
  },
]

export const providerById = (id: string): Provider =>
  PROVIDERS.find((provider) => provider.id === id) ?? PROVIDERS[0]

/**
 * One slot per provider, so switching does not silently reuse the wrong key —
 * and still sessionStorage, so every one of them dies with the tab.
 */
export const keyStorageKey = (providerId: string) => `tokenlens.key.${providerId}`
