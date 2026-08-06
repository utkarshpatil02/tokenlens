/**
 * Classification schema — the browser port of `tokenlens/classify/schema.py`.
 *
 * Category and complexity are deliberately separate axes. Category is for
 * reporting and segmentation only; it does **not** determine which model a task
 * needed. An earlier design mapped category straight to a required tier, which
 * was wrong twice over: coding is among the most defensible uses of a frontier
 * model, so recommending a downgrade there is bad advice, and category does not
 * imply difficulty — "write a function to parse JSON" and "refactor this
 * 2,000-line module without changing behaviour" are both coding and need
 * different models.
 *
 * Complexity is the axis the Waste Score actually needs, so it is the one the
 * classifier reports confidence for and the one escalation exists to protect.
 *
 * Only the schema is ported. Producing classifications costs money and needs a
 * key; consuming them does not, which is what lets hand labels drive the whole
 * scoring pipeline with nothing to pay for.
 */

/** What the prompt is for. Reporting only — never drives required tier. */
export type Category = 'coding' | 'research' | 'writing' | 'summarization' | 'busywork'

/** How hard the task is. Drives the required model tier. */
export type Complexity = 'trivial' | 'moderate' | 'complex'

export const CATEGORIES: Category[] = [
  'coding',
  'research',
  'writing',
  'summarization',
  'busywork',
]

export const COMPLEXITIES: Complexity[] = ['trivial', 'moderate', 'complex']

export const REQUIRED_TIER: Record<Complexity, number> = {
  trivial: 1,
  moderate: 2,
  complex: 3,
}

/**
 * Hand labels can stand in for classifier output so the pipeline runs without
 * spending anything. They carry this prefix in `model` so nothing downstream
 * mistakes a human judgement for a prediction — validation in particular must
 * refuse to score labels against themselves, which would report perfect
 * agreement and mean nothing at all.
 */
export const HUMAN_MODEL_PREFIX = 'human:'

export const requiredTierFor = (complexity: Complexity): number =>
  REQUIRED_TIER[complexity]

/** A finished classification, carrying its own provenance. */
export interface Classification {
  category: Category
  complexity: Complexity
  confidence: number
  rationale: string
  model: string
  escalated?: boolean
  /**
   * Pre-escalation values, retained alongside the final ones so validation can
   * report agreement both before and after escalation. An improving figure is a
   * stronger result than a flat one, but only if the earlier answer was kept.
   */
  base_category?: Category | null
  base_complexity?: Complexity | null
  base_confidence?: number | null
}

export const requiredTier = (found: Classification): number =>
  requiredTierFor(found.complexity)

/** Busywork: a task where LLM use is not justified at any tier. */
export const isZeroValue = (found: Classification): boolean =>
  found.category === 'busywork'

/** Whether this is a hand label standing in for a prediction. */
export const isHuman = (found: Classification): boolean =>
  found.model.startsWith(HUMAN_MODEL_PREFIX)

/** Whether escalation actually altered the tier-driving axis. */
export const complexityChangedOnEscalation = (found: Classification): boolean =>
  Boolean(found.escalated) &&
  found.base_complexity != null &&
  found.base_complexity !== found.complexity
