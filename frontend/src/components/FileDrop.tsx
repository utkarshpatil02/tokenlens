import { useRef, useState } from 'react'

import { ExportPrompt } from './ExportPrompt'

interface Props {
  onFile: (file: File) => void
  onSample: () => void
  busy: boolean
}

/**
 * The empty state.
 *
 * Most visitors arrive without an export in hand, so a bare drop target would
 * end the session in five seconds. The sample file is the way out of that: it is
 * a real CSV through the real pipeline, not a canned result, so it demonstrates
 * the tool rather than describing it.
 *
 * The privacy line is the headline rather than fine print. For a tool whose
 * whole subject is prompts and spend, "this never leaves your browser" is the
 * strongest thing there is to say, and it is only credible if it is said before
 * the user hands over the file.
 */
export function FileDrop({ onFile, onSample, busy }: Props) {
  const [dragging, setDragging] = useState(false)
  // Drag events fire for every nested element, so a plain boolean flickers off
  // the moment the pointer crosses a child. Counting enter/leave pairs does not.
  const depth = useRef(0)

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    depth.current = 0
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file) onFile(file)
  }

  return (
    <div
      className={`dropzone${dragging ? ' dragging' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault()
        depth.current += 1
        setDragging(true)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => {
        depth.current -= 1
        if (depth.current <= 0) setDragging(false)
      }}
      onDrop={handleDrop}
    >
      <p className="drop-title">Drop a usage export here</p>
      <p className="drop-sub">
        CSV or TSV from Claude Console, OpenAI, Helicone, OpenRouter — or anything
        with a model column.
      </p>

      <div className="drop-actions">
        <label className="button-like">
          Choose a file
          <input
            type="file"
            className="sr-only"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) onFile(file)
              // Reset so choosing the same file twice still fires a change.
              event.target.value = ''
            }}
          />
        </label>
        <button type="button" onClick={onSample} disabled={busy}>
          Try a sample file
        </button>
      </div>

      <p className="drop-privacy">
        Read in your browser. There is no server here to send it to.
      </p>

      <ExportPrompt />
    </div>
  )
}
