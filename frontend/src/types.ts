/**
 * Mirrors the payload from GET /api/analysis.
 *
 * Money arrives as decimal strings, not numbers, so exact values survive the
 * wire. Convert with `money()` only at the point of display — never store the
 * float back, or the precision the backend went to some trouble to preserve is
 * lost anyway.
 */

export type Band = 'efficient' | 'moderate' | 'high' | 'critical'

export interface Overview {
  total_cost: string
  turns: number
  scorable_turns: number
  classified_turns: number
  calls: number
  mean_calls_per_turn: number
  total_tokens: number
  sessions: number
}

export interface TokenCategoryRow {
  category: string
  label: string
  cost: string
  tokens: number
  share: number
}

export interface ModelRow {
  model: string
  tier: number
  cost: string
  calls: number
  share: number
}

export interface CallsPerTurnRow {
  calls: number
  turns: number
}

export interface BandRow {
  band: Band
  turns: number
  cost: string
}

export interface HeatmapCell {
  complexity: string
  required_tier: number
  tier_used: number
  turns: number
  cost: string
  waste: string
}

export interface CategoryRow {
  category: string
  turns: number
  cost: string
}

export interface LeaderboardRow {
  turn_id: string
  prompt: string | null
  category: string
  complexity: string
  confidence: number
  escalated: boolean
  rationale: string
  calls: number
  actual_cost: string
  estimated_waste: string
  overshoot: string
  bloat: string
  excess_tokens: number
  bloat_measured: boolean
  tier_used: number
  tier_required: number
  normalized: number
  band: Band
  zero_value: boolean
  under_provisioned: boolean
  recommendation: string
}

/** One model that produced labels, and how many turns it accounts for. */
export interface SourceModel {
  model: string
  turns: number
}

/**
 * Where the labels behind the waste figures came from.
 *
 * This started as a single word, which stopped being enough the moment a second
 * provider existed: a score labelled by Gemini and one labelled by Haiku are
 * different measurements, and rendering both as "classifier" presents them as
 * the same thing. Escalation makes it worse — one Claude run produces labels
 * from two models, and how many escalated is exactly what a reader wants to
 * know.
 *
 * `kind` stays the discriminator because the question it answers is still the
 * first one that matters: if any of these labels were made by a person, the
 * figures say nothing about classifier accuracy.
 */
export interface WasteSource {
  kind: 'classifier' | 'hand-labelled' | 'mixed'
  /** Models that produced labels, most-used first. Empty when hand-labelled. */
  models: SourceModel[]
  /**
   * Turns judged by a person. Absent on snapshots frozen before this field
   * existed — the dashboard shows what it knows rather than inventing a count.
   */
  human_turns?: number
}

/** What older frozen snapshots carry in `waste.source`. */
export type LegacySource = 'classifier' | 'hand-labelled' | 'mixed'

export interface Waste {
  total_waste: string
  scored_cost: string
  waste_share: number
  scored_turns: number
  unmeasured_bloat_turns: number
  /** Which labels produced these figures, and from which models. */
  source: WasteSource
  components: {
    overshoot: string
    bloat: string
    zero_value_cost: string
  }
  bands: BandRow[]
  complexity_by_tier: HeatmapCell[]
  category_distribution: CategoryRow[]
  leaderboard: LeaderboardRow[]
  flags: {
    under_provisioned: number
    zero_value: number
    escalated: number
    escalation_changed_tier: number
  }
}

export interface Analysis {
  generated_at: string
  rate_table: { version: number; updated: string; currency: string }
  overview: Overview
  cost_by_token_category: TokenCategoryRow[]
  cost_by_model: ModelRow[]
  calls_per_turn: CallsPerTurnRow[]
  /** Null until prompts have been classified — not zero. */
  waste: Waste | null
  /** Present only on a frozen snapshot served without a backend. */
  snapshot?: { static: boolean; prompts_redacted: boolean }
}

export interface Health {
  status: string
  version: string
  projects_path: string
  projects_path_exists: boolean
  cache_path: string
  has_api_key: boolean
}
