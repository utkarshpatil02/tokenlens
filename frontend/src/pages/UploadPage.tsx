import { ColumnMapper } from '../components/ColumnMapper'
import { FileDrop } from '../components/FileDrop'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { Notice } from '../components/ui/Notice'
import { SectionHead } from '../components/ui/SectionHead'
import { ROUTES } from '../router'
import type { UploadSession } from '../session'

/** Enough rows to show the shape of a real agentic export, in a few lines. */
const SAMPLE_CSV = [
  'model,timestamp,input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,trace_id,session_id,prompt',
  'claude-opus-5,2026-07-26T09:14:02Z,2,286,34488,12359,t1,s1,"port the pricing engine to TypeScript"',
  'claude-opus-5,2026-07-26T09:14:31Z,0,1204,46847,0,t1,s1,',
  'claude-opus-5,2026-07-26T09:15:10Z,0,318,58203,0,t1,s1,',
  'claude-opus-5,2026-07-26T10:02:11Z,4,52,18220,6100,t2,s1,"rename this variable"',
  'claude-haiku-4-5,2026-07-26T10:44:57Z,120,88,0,0,t3,s1,"what does cache_write_1h mean?"',
  'claude-sonnet-5,2026-07-26T11:19:03Z,8,940,29115,8800,t4,s2,"write tests for the CSV reader"',
  'claude-sonnet-5,2026-07-26T11:19:48Z,0,612,33901,0,t4,s2,',
].join('\n')

interface Props {
  session: UploadSession
  onNavigate: (to: string) => void
}

/**
 * The entry point: drop a file, confirm what its columns mean, and go.
 *
 * Everything happens in this tab. The file is read, parsed, mapped, priced and
 * aggregated without a network request, which is what makes "nothing leaves
 * your browser" a fact about the architecture rather than a promise in the copy.
 */
export function UploadPage({ session, onNavigate }: Props) {
  const { state } = session

  return (
    <>
      <SectionHead
        title="Analyze your own export"
        aside={
          <span className="section-note badge-private">
            <Icon name="lock" size={12} />
            nothing leaves your browser
          </span>
        }
      />

      {state.kind === 'empty' && (
        <FileDrop
          busy={false}
          onFile={session.onFile}
          onSample={() =>
            void session.load('sample-export.csv', async () => SAMPLE_CSV)
          }
        />
      )}

      {state.kind === 'reading' && (
        <div className="center" role="status">
          <Icon name="spinner" /> Reading {state.name}…
        </div>
      )}

      {state.kind === 'mapping' && (
        <ColumnMapper
          fileName={state.name}
          header={state.parsed.header}
          sampleRows={state.parsed.rows}
          rowCount={state.parsed.rows.length}
          mapping={state.mapping}
          onChange={session.setMapping}
          onConfirm={() => {
            session.confirm()
            onNavigate(ROUTES.overview)
          }}
          onCancel={session.reset}
        />
      )}

      {state.kind === 'failed' && (
        <Notice
          title={`Could not read ${state.name}`}
          tone="error"
          actions={<Button onClick={session.reset}>Try another file</Button>}
        >
          <p>{state.message}</p>
        </Notice>
      )}

      {state.kind === 'ready' && (
        <Notice
          title={`${state.name} is analysed`}
          actions={
            <>
              <Button variant="primary" onClick={() => onNavigate(ROUTES.overview)}>
                See the overview
              </Button>
              <Button icon="upload" onClick={session.reset}>
                Analyze another file
              </Button>
            </>
          }
        >
          <p>
            Priced and aggregated in this tab. Use the menu to move between the
            overview, the spend breakdown and the waste score.
          </p>
        </Notice>
      )}
    </>
  )
}
