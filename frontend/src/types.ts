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

export interface Waste {
  total_waste: string
  scored_cost: string
  waste_share: number
  scored_turns: number
  unmeasured_bloat_turns: number
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
}

export interface Health {
  status: string
  version: string
  projects_path: string
  projects_path_exists: boolean
  cache_path: string
  has_api_key: boolean
}
