/**
 * Cost-ordered hand labelling.
 *
 * Scoring waste needs a classification per turn, and producing one with a model
 * costs money and needs a key. A human already has the judgement for free, so
 * this is the path that gets an uploaded export from "here is what it cost" to
 * "here is what it should have cost" with nothing to pay for and nothing to
 * configure.
 *
 * The ordering is the whole design. Waste is denominated in dollars and spend is
 * extremely concentrated — in the reference corpus the ten most expensive turns
 * of 113 carry 45% of the spend, thirty carry 78%. Labelling in corpus order
 * means most of the effort buys almost none of the answer. Labelling most
 * expensive first means the answer is mostly known after a couple of minutes,
 * and the person can stop the moment the remaining spend stops mattering — which
 * is why progress here is measured in **dollars covered**, not turns done.
 *
 * A label is deliberately allowed to be half-finished. Category and complexity
 * are independent judgements made a keystroke apart, and a state model that only
 * admits complete labels would have to either buffer the first choice invisibly
 * or discard it. `PartialLabel` makes the intermediate state explicit, and
 * `toClassifications` is what decides that only whole ones count.
 */

import { HUMAN_MODEL_PREFIX } from './classification'
import type { Category, Classification, Complexity } from './classification'
import { ZERO } from './money'
import type { Money } from './money'
import { isScorable } from './models'
import type { Turn } from './models'
import { defaultTable } from './pricing'
import type { PriceTable } from './pricing'

/**
 * Stamped into every label made here.
 *
 * Mirrors what `validation/labels.py` writes for a CSV label set: the `human:`
 * prefix is what stops anything downstream reading a human judgement as a
 * prediction, and validation in particular refuses to score labels against
 * themselves rather than reporting a meaningless perfect agreement.
 */
export const BROWSER_LABEL_MODEL = `${HUMAN_MODEL_PREFIX}browser`

/**
 * Confidence is 1.0 for the same reason the Python side uses it: these are
 * reference labels, not a prediction carrying uncertainty.
 */
export const handLabel = (
  category: Category,
  complexity: Complexity,
): Classification => ({
  category,
  complexity,
  confidence: 1,
  rationale: 'hand-labelled in the browser',
  model: BROWSER_LABEL_MODEL,
})

/** One axis, both axes, or neither — whatever has been decided so far. */
export interface PartialLabel {
  category: Category | null
  complexity: Complexity | null
}

export const EMPTY_LABEL: PartialLabel = { category: null, complexity: null }

export const isComplete = (label: PartialLabel | undefined): boolean =>
  Boolean(label?.category && label.complexity)

/** One turn to label, with the cost that earned it its place in the queue. */
export interface LabelTask {
  turn: Turn
  cost: Money
  /** Share of the queue's spend this one turn carries, 0 to 1. */
  share: number
}

export interface LabelQueue {
  /** Most expensive first. */
  tasks: LabelTask[]
  /** Spend across the queue — the denominator progress is measured against. */
  queueCost: Money
  /** Spend across every turn, including those that can never be labelled. */
  totalCost: Money
  /**
   * Turns with no prompt text. They cost real money and are counted in
   * `totalCost`, but there is nothing to judge, so they can never be scored.
   */
  unlabellable: number
}

const shareOf = (part: Money, whole: Money): number =>
  whole <= ZERO ? 0 : Number(part) / Number(whole)

/**
 * Every labellable turn, most expensive first.
 *
 * Turns without prompt text are excluded rather than queued and skipped: a
 * queue that cannot be finished makes the progress bar a lie, and the spend they
 * represent is reported separately as `unlabellable`.
 *
 * The sort is stable, so turns costing the same keep corpus order — the same
 * property the leaderboard and `Counter.most_common` rely on, and what keeps a
 * second pass over the same file in the same order as the first.
 */
export const buildLabelQueue = (
  turns: Turn[],
  table: PriceTable = defaultTable(),
): LabelQueue => {
  const costOf = (turn: Turn): Money =>
    turn.calls.reduce((total, call) => total + table.costOf(call), ZERO)

  let totalCost = ZERO
  let unlabellable = 0
  let queueCost = ZERO
  const priced: { turn: Turn; cost: Money }[] = []

  for (const turn of turns) {
    const cost = costOf(turn)
    totalCost += cost
    if (!isScorable(turn)) {
      unlabellable += 1
      continue
    }
    queueCost += cost
    priced.push({ turn, cost })
  }

  const tasks = [...priced]
    .sort((a, b) => (b.cost > a.cost ? 1 : b.cost < a.cost ? -1 : 0))
    .map(({ turn, cost }) => ({ turn, cost, share: shareOf(cost, queueCost) }))

  return { tasks, queueCost, totalCost, unlabellable }
}

export interface LabelProgress {
  /** Turns with both axes decided — the ones that will actually be scored. */
  labelled: number
  /** Turns with exactly one axis decided. Started, not usable. */
  partial: number
  total: number
  labelledCost: Money
  queueCost: Money
  /** Labelled spend as a share of the queue, 0 to 1. This is the progress bar. */
  spendShare: number
  /** Labelled spend as a share of the whole file, 0 to 1. */
  fileShare: number
}

export const labelProgress = (
  queue: LabelQueue,
  labels: Map<string, PartialLabel>,
): LabelProgress => {
  let labelled = 0
  let partial = 0
  let labelledCost = ZERO

  for (const task of queue.tasks) {
    const label = labels.get(task.turn.turn_id)
    if (isComplete(label)) {
      labelled += 1
      labelledCost += task.cost
    } else if (label?.category || label?.complexity) {
      partial += 1
    }
  }

  return {
    labelled,
    partial,
    total: queue.tasks.length,
    labelledCost,
    queueCost: queue.queueCost,
    spendShare: shareOf(labelledCost, queue.queueCost),
    fileShare: shareOf(labelledCost, queue.totalCost),
  }
}

/** The complete labels only, in the shape `scoreTurns` consumes. */
export const toClassifications = (
  labels: Map<string, PartialLabel>,
): Map<string, Classification> => {
  const out = new Map<string, Classification>()
  for (const [turnId, label] of labels) {
    if (label.category && label.complexity) {
      out.set(turnId, handLabel(label.category, label.complexity))
    }
  }
  return out
}

/**
 * Whether choosing an axis should move the person on to the next turn.
 *
 * Advancing the instant a label completes is what makes the flow fast enough to
 * be worth doing — but only for a turn that was not already finished. Going back
 * to correct something and being thrown forward again by the first of two
 * corrections is the obvious way to make that same rule infuriating, so a turn
 * that was already complete stays put and is left to the arrow keys.
 */
export const shouldAdvance = (
  before: PartialLabel | undefined,
  after: PartialLabel,
): boolean => !isComplete(before) && isComplete(after)

/**
 * Index of the first turn not yet fully labelled.
 *
 * Reopening the screen mid-pass should resume rather than start over. Returns
 * the queue length when everything is done, which is the position the finished
 * card sits at.
 */
export const firstUnlabelled = (
  queue: LabelQueue,
  labels: Map<string, PartialLabel>,
): number => {
  const index = queue.tasks.findIndex((task) => !isComplete(labels.get(task.turn.turn_id)))
  return index === -1 ? queue.tasks.length : index
}

/**
 * How much of the queue's spend the top `n` turns carry.
 *
 * The claim that a short pass answers most of the question is checkable per
 * file rather than asserted from the reference corpus, so the screen states it
 * for the file in hand.
 */
export const spendCoveredBy = (queue: LabelQueue, n: number): number => {
  let covered = ZERO
  for (const task of queue.tasks.slice(0, Math.max(0, n))) covered += task.cost
  return shareOf(covered, queue.queueCost)
}
