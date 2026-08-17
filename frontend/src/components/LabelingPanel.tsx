import { useEffect, useState } from 'react'

import { CATEGORIES, COMPLEXITIES, REQUIRED_TIER } from '../engine/classification'
import type { Category, Complexity } from '../engine/classification'
import {
  firstUnlabelled,
  isComplete,
  labelProgress,
  shouldAdvance,
  spendCoveredBy,
} from '../engine/labeling'
import type { LabelQueue, PartialLabel } from '../engine/labeling'
import { formatMoney } from '../engine/money'
import { modelsUsed } from '../engine/models'
import { pct, usd } from '../format'
import { Button } from './ui/Button'
import { Notice } from './ui/Notice'
import { Progress as ProgressBar } from './ui/Progress'

interface Props {
  queue: LabelQueue
  labels: Map<string, PartialLabel>
  onChange: (labels: Map<string, PartialLabel>) => void
  onDone: () => void
  onCancel: () => void
}

/**
 * The definitions the classifier is given, in the classifier's own words.
 *
 * Not a paraphrase: these labels are meant to become the reference set the
 * classifier is measured against, and two judges answering subtly different
 * questions would make that agreement figure meaningless. Kept in step with
 * `SYSTEM_PROMPT` in `backend/tokenlens/classify/classifier.py`.
 */
const CATEGORY_HELP: Record<Category, string> = {
  coding: 'writing, debugging, reviewing, or explaining code',
  research: 'finding, gathering, comparing, or investigating information',
  writing: 'composing prose, documentation, messages, or creative text',
  summarization: 'condensing or extracting from text you supplied',
  busywork: 'a chore where using a model at all was not justified',
}

const COMPLEXITY_HELP: Record<Complexity, string> = {
  trivial: 'single step, no reasoning, no context to integrate',
  moderate: 'several steps, or synthesising context you provided',
  complex: 'extended reasoning, long context, or costly to get wrong',
}

/** Mnemonic and unambiguous; complexity keeps 1/2/3 for the ordered axis. */
const CATEGORY_KEY: Record<Category, string> = {
  coding: 'c',
  research: 'r',
  writing: 'w',
  summarization: 's',
  busywork: 'b',
}

/**
 * Cost-ordered hand labelling.
 *
 * The screen exists because the one input the Waste Score cannot compute is a
 * judgement about the task, and buying that judgement from a model costs money
 * and needs a key. A person has it already.
 *
 * Two decisions do most of the work. Turns arrive **most expensive first**,
 * because waste is denominated in dollars and spend is concentrated enough that
 * a dozen turns usually settle most of the answer. And progress is reported in
 * **dollars covered rather than turns done**, so stopping early is a visible,
 * quantified choice — "78% of the spend is accounted for" — instead of an
 * abandoned task.
 */
export function LabelingPanel({ queue, labels, onChange, onDone, onCancel }: Props) {
  const [index, setIndex] = useState(() => firstUnlabelled(queue, labels))

  const total = queue.tasks.length
  const finished = index >= total
  const task = finished ? null : queue.tasks[index]
  const current = task ? labels.get(task.turn.turn_id) : undefined
  const progress = labelProgress(queue, labels)

  const go = (to: number) => setIndex(Math.max(0, Math.min(total, to)))

  const choose = (axis: 'category' | 'complexity', value: Category | Complexity) => {
    if (!task) return
    const before = labels.get(task.turn.turn_id)
    const after: PartialLabel = {
      category: before?.category ?? null,
      complexity: before?.complexity ?? null,
      [axis]: value,
    }
    const next = new Map(labels)
    next.set(task.turn.turn_id, after)
    onChange(next)
    if (shouldAdvance(before, after)) go(index + 1)
  }

  const clear = () => {
    if (!task) return
    const next = new Map(labels)
    next.delete(task.turn.turn_id)
    onChange(next)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      // Never swallow a keystroke meant for something the person is typing in.
      // `closest` is checked rather than assumed: a keydown dispatched at
      // `window` or `document` — which extensions, a11y tooling and test
      // harnesses all do — has a target that is not an Element, and calling it
      // blind throws and takes the whole key handler down with it.
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [contenteditable]')
      ) {
        return
      }

      if (event.key === 'ArrowRight') {
        go(index + 1)
      } else if (event.key === 'ArrowLeft') {
        go(index - 1)
      } else if (event.key === 'Backspace') {
        clear()
      } else {
        const complexity = COMPLEXITIES[Number(event.key) - 1]
        const category = CATEGORIES.find(
          (name) => CATEGORY_KEY[name] === event.key.toLowerCase(),
        )
        if (complexity) choose('complexity', complexity)
        else if (category) choose('category', category)
        else return
      }
      event.preventDefault()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // No dependency array on purpose: the handler closes over the current index
    // and label map, and a stale closure here would silently label the wrong
    // turn — the one failure this screen must not have.
  })

  return (
    <div className="labeler">
      <div className="mapper-head">
        <div>
          <h3>Label prompts, most expensive first</h3>
          <p className="section-note">
            Two judgements per prompt. Nothing is sent anywhere, and you can stop as
            soon as enough of the spend is covered.
          </p>
        </div>
        <div className="mapper-actions">
          <button type="button" onClick={onCancel}>
            Close
          </button>
          <button
            type="button"
            className="primary"
            onClick={onDone}
            disabled={progress.labelled === 0}
          >
            Score {progress.labelled} labelled turn{progress.labelled === 1 ? '' : 's'}
          </button>
        </div>
      </div>

      <Progress queue={queue} progress={progress} />

      {finished ? (
        <Notice
          title="Every prompt is labelled"
          actions={<Button onClick={() => go(0)}>Review from the top</Button>}
        >
          <p>
            All {total} turns carrying prompt text are done — {usd(
              formatMoney(progress.labelledCost),
            )}{' '}
            of spend, {pct(progress.fileShare)} of the file.
            {queue.unlabellable > 0 &&
              ` The remaining ${queue.unlabellable} turn${
                queue.unlabellable === 1 ? '' : 's'
              } carry no prompt text, so there is nothing to judge.`}
          </p>
        </Notice>
      ) : (
        <>
          <PromptCard
            queue={queue}
            index={index}
            label={current}
            onChoose={choose}
          />

          <div className="labeler-nav">
            <button type="button" onClick={() => go(index - 1)} disabled={index === 0}>
              ← Previous
            </button>
            <span className="labeler-hint">
              <kbd>c</kbd> <kbd>r</kbd> <kbd>w</kbd> <kbd>s</kbd> <kbd>b</kbd> category ·{' '}
              <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> complexity · <kbd>←</kbd>{' '}
              <kbd>→</kbd> move · <kbd>⌫</kbd> clear
            </span>
            <button type="button" onClick={() => go(index + 1)}>
              {isComplete(current) ? 'Next →' : 'Skip →'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** Dollars covered, because that is what stopping early actually trades away. */
function Progress({
  queue,
  progress,
}: {
  queue: LabelQueue
  progress: ReturnType<typeof labelProgress>
}) {
  // Stated for this file rather than borrowed from the reference corpus: on a
  // flat export a short pass buys much less, and the claim should say so. Below
  // ten turns there is nothing to concentrate and the line is not worth the
  // reader's attention.
  const shortPass = 10

  return (
    <ProgressBar
      share={progress.spendShare}
      label={`${pct(progress.spendShare)} of labellable spend covered`}
    >
      <span className="labeler-covered">{pct(progress.spendShare)} of spend covered</span>
      <span>
        {progress.labelled} of {progress.total} turns ·{' '}
        {usd(formatMoney(progress.labelledCost))} of{' '}
        {usd(formatMoney(progress.queueCost))}
      </span>
      {progress.labelled === 0 && progress.total > shortPass && (
        <span className="quiet">
          the top {shortPass} carry {pct(spendCoveredBy(queue, shortPass))} of it
        </span>
      )}
    </ProgressBar>
  )
}

function PromptCard({
  queue,
  index,
  label,
  onChoose,
}: {
  queue: LabelQueue
  index: number
  label: PartialLabel | undefined
  onChoose: (axis: 'category' | 'complexity', value: Category | Complexity) => void
}) {
  const task = queue.tasks[index]
  const { turn } = task
  const models = modelsUsed(turn)

  return (
    <div className="panel labeler-card">
      <div className="labeler-card-head">
        <span className="labeler-position">
          #{index + 1} of {queue.tasks.length}
        </span>
        <span className="labeler-cost">{usd(formatMoney(task.cost))}</span>
        <span className="labeler-meta">
          {pct(task.share)} of spend · {turn.calls.length} call
          {turn.calls.length === 1 ? '' : 's'} · {models.join(', ')}
        </span>
      </div>

      <div className="labeler-prompt">{turn.prompt_text}</div>

      <div className="labeler-axis">
        <div className="labeler-axis-head">
          <h4>Category</h4>
          <span className="labeler-axis-note">
            reporting only — it never changes which model the task needed
          </span>
        </div>
        <div className="labeler-choices">
          {CATEGORIES.map((category) => (
            <button
              key={category}
              type="button"
              className={`labeler-choice${label?.category === category ? ' chosen' : ''}`}
              aria-pressed={label?.category === category}
              onClick={() => onChoose('category', category)}
            >
              <span className="labeler-choice-name">
                <kbd>{CATEGORY_KEY[category]}</kbd> {category}
              </span>
              <span className="labeler-choice-help">{CATEGORY_HELP[category]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="labeler-axis">
        <div className="labeler-axis-head">
          <h4>Complexity</h4>
          <span className="labeler-axis-note">
            how hard the task was, not how hard the topic sounds — this is what sets
            the tier the turn needed
          </span>
        </div>
        <div className="labeler-choices">
          {COMPLEXITIES.map((complexity, position) => (
            <button
              key={complexity}
              type="button"
              className={`labeler-choice${
                label?.complexity === complexity ? ' chosen' : ''
              }`}
              aria-pressed={label?.complexity === complexity}
              onClick={() => onChoose('complexity', complexity)}
            >
              <span className="labeler-choice-name">
                <kbd>{position + 1}</kbd> {complexity}
                <span className="labeler-tier">tier {REQUIRED_TIER[complexity]}</span>
              </span>
              <span className="labeler-choice-help">{COMPLEXITY_HELP[complexity]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
