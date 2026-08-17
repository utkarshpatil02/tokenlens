import { useEffect, useState } from 'react'

import { CSV_PROMPT } from './csvPrompt'
import { Button } from './ui/Button'

/**
 * "I don't have a file in the right shape."
 *
 * The drop zone assumes a usable export. Plenty of people have *something* —
 * a console download, a Helicone dump, a JSON blob — in the wrong shape, and
 * the column mapper only helps once a CSV exists. This hands them a prompt that
 * converts what they have, using whichever assistant they already pay for.
 *
 * Folded away by default. Someone holding the right file should not have to
 * scroll past instructions for a problem they do not have.
 */
export function ExportPrompt() {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 3000)
    return () => clearTimeout(timer)
  }, [state])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CSV_PROMPT)
      setState('copied')
    } catch {
      // Refusal is routine, not exotic: an insecure origin, a permission
      // policy, or simply a window that does not have focus. Saying so beats
      // a button that appears to do nothing — the text is right there and
      // selectable, but only if the person is told to select it.
      setState('failed')
    }
  }

  return (
    <details className="export-prompt">
      <summary>No export, or the wrong shape? Get one with a prompt</summary>

      <p className="section-note">
        Paste this into ChatGPT, Claude or Gemini <strong>along with the export you
        already have</strong> — a console download, a Helicone or OpenRouter dump, even
        a JSON blob — and it will reshape it into the columns this page reads.
      </p>
      <p className="section-note">
        It converts your data; it cannot conjure it. No assistant can see your billing
        account, so the prompt tells it to leave gaps empty rather than fill them with
        plausible numbers — a guessed token count would produce a confident cost figure
        for spend that never happened.
      </p>

      <div className="prompt-actions">
        <Button
          variant="primary"
          icon={state === 'copied' ? 'check' : 'copy'}
          onClick={() => void copy()}
        >
          {state === 'copied' ? 'Copied' : 'Copy prompt'}
        </Button>
        <span className="section-note" role="status">
          {state === 'failed'
            ? 'Your browser blocked the clipboard — select the text below and copy it.'
            : 'then paste your export underneath it'}
        </span>
      </div>

      <textarea
        className="prompt-text"
        readOnly
        rows={12}
        value={CSV_PROMPT}
        onFocus={(event) => event.currentTarget.select()}
      />
    </details>
  )
}
