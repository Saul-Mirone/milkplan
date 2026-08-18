import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ActionBar } from '../../src/ui/components/ActionBar'
import type { PlanEditorHandle } from '../../src/ui/components/PlanEditor'
import type { AnnotationRecord } from '../../src/ui/annotations/plugin'
import type { DeepReadonly } from '../../src/shared/readonly'

interface Sent {
  path: string
  body: unknown
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Records every /api call and answers with the given outcome. */
function stubFetch(ok = true): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal(
    'fetch',
    (input: string, init?: DeepReadonly<{ body?: string }>) => {
      sent.push({
        path: input,
        body: init?.body === undefined ? undefined : JSON.parse(init.body),
      })
      return Promise.resolve({
        ok,
        status: ok ? 200 : 500,
        json: () => Promise.resolve({ ok }),
      })
    },
  )
  return sent
}

function record(
  overrides: DeepReadonly<Partial<AnnotationRecord>> = {},
): AnnotationRecord {
  return {
    id: 'a1',
    from: 1,
    to: 6,
    comment: 'why this?',
    createdExcerpt: 'Intro',
    orphaned: false,
    pending: false,
    ...overrides,
  }
}

function handle(markdown: string, edited: boolean): PlanEditorHandle {
  return {
    getMarkdown: () => markdown,
    isEdited: () => edited,
    getView: () => null,
  }
}

interface Options {
  annotations?: readonly AnnotationRecord[]
  overallFeedback?: string
  editor?: PlanEditorHandle | null
}

function renderBar(options: DeepReadonly<Options> = {}): {
  done: ('sent' | 'skipped')[]
} {
  const done: ('sent' | 'skipped')[] = []
  render(
    <ActionBar
      editorRef={{ current: options.editor ?? null }}
      annotations={options.annotations ?? []}
      excerptFor={(candidate) => candidate.createdExcerpt}
      overallFeedback={options.overallFeedback ?? ''}
      onDone={(variant) => {
        done.push(variant)
      }}
    />,
  )
  return { done }
}

const approve = () => screen.getByRole('button', { name: 'Approve' })
const requestChanges = () =>
  screen.getByRole('button', { name: 'Request changes' })
const skip = () => screen.getByRole('button', { name: 'Skip review' })
const theme = () => screen.getByRole('button', { name: /^Theme:/u })

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('ActionBar', () => {
  it('blocks Request changes until there is something to say', () => {
    // A deny with no comments and no feedback tells Claude to revise without
    // saying what to revise, and it would loop straight back to ExitPlanMode.
    stubFetch()
    renderBar()
    expect(requestChanges().hasAttribute('disabled')).toBe(true)
    expect(requestChanges().getAttribute('title')).toContain(
      'at least one annotation',
    )
  })

  it('enables Request changes once an annotation exists', () => {
    stubFetch()
    renderBar({ annotations: [record()] })
    expect(requestChanges().hasAttribute('disabled')).toBe(false)
  })

  it('enables Request changes once there is overall feedback', () => {
    stubFetch()
    renderBar({ overallFeedback: 'needs work' })
    expect(requestChanges().hasAttribute('disabled')).toBe(false)
  })

  it('treats whitespace-only feedback as nothing to say', () => {
    stubFetch()
    renderBar({ overallFeedback: '   ' })
    expect(requestChanges().hasAttribute('disabled')).toBe(true)
  })

  it('posts an approval carrying the annotations, trimmed feedback and edits', async () => {
    const sent = stubFetch()
    const { done } = renderBar({
      annotations: [record({ orphaned: true })],
      overallFeedback: '  ship it  ',
      editor: handle('# Revised\n', true),
    })

    fireEvent.click(approve())

    await waitFor(() => {
      expect(done).toEqual(['sent'])
    })
    expect(sent).toEqual([
      {
        path: '/api/decision',
        body: {
          action: 'approve',
          annotations: [
            { excerpt: 'Intro', comment: 'why this?', orphaned: true },
          ],
          overallFeedback: 'ship it',
          editedMarkdown: '# Revised\n',
        },
      },
    ])
  })

  it('sends the mode chosen in the dropdown along with the approval', async () => {
    const sent = stubFetch()
    renderBar({ overallFeedback: 'needs work' })

    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'acceptEdits' },
    })
    fireEvent.click(approve())
    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sent[0]?.body).toMatchObject({ permissionMode: 'acceptEdits' })
  })

  it('posts a skip without building a decision at all', async () => {
    const sent = stubFetch()
    const { done } = renderBar()

    fireEvent.click(skip())

    await waitFor(() => {
      expect(done).toEqual(['skipped'])
    })
    expect(sent).toEqual([{ path: '/api/skip', body: undefined }])
  })

  it('disables every action while a request is in flight', () => {
    // Two decisions from one review would race, and the second would arrive
    // after the CLI had already exited.
    stubFetch()
    renderBar({ overallFeedback: 'needs work' })

    fireEvent.click(approve())

    expect(approve().hasAttribute('disabled')).toBe(true)
    expect(requestChanges().hasAttribute('disabled')).toBe(true)
    expect(skip().hasAttribute('disabled')).toBe(true)
  })

  it('keeps the theme toggle usable while a decision is in flight', () => {
    // Every other control locks so a second decision cannot race the first.
    // This one changes nothing the CLI will ever see, and a reviewer who
    // triggered a slow send should still be able to read the page.
    stubFetch()
    renderBar({ overallFeedback: 'needs work' })
    expect(theme().hasAttribute('disabled')).toBe(false)

    fireEvent.click(approve())

    expect(skip().hasAttribute('disabled')).toBe(true)
    expect(theme().hasAttribute('disabled')).toBe(false)
  })

  it('surfaces a failed send and re-enables the buttons instead of claiming success', async () => {
    // The CLI may already have exited; reporting "sent" here would leave the
    // user believing a decision landed when nothing did.
    stubFetch(false)
    const { done } = renderBar()

    fireEvent.click(approve())

    await waitFor(() => {
      expect(screen.getByText(/failed with status 500/u)).toBeDefined()
    })
    expect(done).toEqual([])
    expect(approve().hasAttribute('disabled')).toBe(false)
  })
})
