import { describe, expect, it } from 'vitest'

import { buildDecision, isModeValue, MODE_OPTIONS } from '../src/ui/decision'
import type { DecisionContext, EditorSnapshot } from '../src/ui/decision'
import type { AnnotationRecord } from '../src/ui/annotations/plugin'
import { APPROVAL_PERMISSION_MODES } from '../src/shared/protocol'
import type { DeepReadonly } from '../src/shared/readonly'

function record(
  overrides: DeepReadonly<Partial<AnnotationRecord>> = {},
): AnnotationRecord {
  return {
    id: 'a1',
    from: 1,
    to: 6,
    comment: 'why?',
    createdExcerpt: 'Intro',
    orphaned: false,
    pending: false,
    ...overrides,
  }
}

function editor(markdown: string, edited: boolean): EditorSnapshot {
  return { isEdited: () => edited, getMarkdown: () => markdown }
}

function ctx(overrides: DeepReadonly<Partial<DecisionContext>> = {}) {
  return {
    annotations: [],
    excerptFor: (candidate: DeepReadonly<AnnotationRecord>) =>
      candidate.createdExcerpt,
    overallFeedback: '',
    editor: null,
    mode: '' as const,
    ...overrides,
  }
}

describe('buildDecision — edits', () => {
  it('sends the markdown only when the editor reports a change', () => {
    const unchanged = buildDecision(
      'approve',
      ctx({ editor: editor('# Plan', false) }),
    )
    expect('editedMarkdown' in unchanged).toBe(false)

    const changed = buildDecision(
      'approve',
      ctx({ editor: editor('# Revised', true) }),
    )
    expect(changed.editedMarkdown).toBe('# Revised')
  })

  it('treats a plan the user emptied as no edit at all', () => {
    // isEdited() is a plain string compare against the parse baseline, so
    // select-all + delete reports an edit whose content is empty. Sending it
    // would blank the plan file on disk and tell Claude the empty document is
    // the authoritative revision — one click, no undo.
    for (const emptied of ['', '   ', '\n\n']) {
      const decision = buildDecision(
        'approve',
        ctx({ editor: editor(emptied, true) }),
      )
      expect({ emptied, sent: 'editedMarkdown' in decision }).toEqual({
        emptied,
        sent: false,
      })
    }
  })

  it('sends nothing when the editor has not mounted yet', () => {
    const decision = buildDecision('approve', ctx({ editor: null }))
    expect('editedMarkdown' in decision).toBe(false)
  })
})

describe('buildDecision — permission mode', () => {
  it('carries every real mode through on approve', () => {
    for (const mode of APPROVAL_PERMISSION_MODES)
      expect(buildDecision('approve', ctx({ mode })).permissionMode).toBe(mode)
  })

  it('omits the field entirely when the user kept the current mode', () => {
    const decision = buildDecision('approve', ctx({ mode: '' }))
    expect('permissionMode' in decision).toBe(false)
  })

  it('never attaches a mode to a request-changes, which grants nothing', () => {
    const decision = buildDecision('request-changes', ctx({ mode: 'auto' }))
    expect('permissionMode' in decision).toBe(false)
  })
})

describe('buildDecision — annotations and feedback', () => {
  it('serializes each record to exactly the three fields the protocol carries', () => {
    // A stray field here reaches the server's validator, which rejects the
    // whole decision with a 400 and leaves the user staring at a failed send.
    const seen: string[] = []
    const decision = buildDecision(
      'request-changes',
      ctx({
        annotations: [
          record({ id: 'a1', comment: 'first' }),
          record({ id: 'a2', comment: 'second', orphaned: true }),
        ],
        excerptFor: (candidate: DeepReadonly<AnnotationRecord>) => {
          seen.push(candidate.id)
          return `excerpt-for-${candidate.id}`
        },
        overallFeedback: '  needs work  ',
      }),
    )

    expect(decision).toEqual({
      action: 'request-changes',
      annotations: [
        { excerpt: 'excerpt-for-a1', comment: 'first', orphaned: false },
        { excerpt: 'excerpt-for-a2', comment: 'second', orphaned: true },
      ],
      overallFeedback: 'needs work',
    })
    // Every record goes through excerptFor, which is what makes an orphan
    // quote its captured text instead of whatever now sits at its positions.
    expect(seen).toEqual(['a1', 'a2'])
  })

  it('trims whitespace-only feedback down to the empty string', () => {
    const decision = buildDecision(
      'approve',
      ctx({ overallFeedback: '  \n\t ' }),
    )
    expect(decision.overallFeedback).toBe('')
  })
})

describe('isModeValue and MODE_OPTIONS', () => {
  it('accepts the empty sentinel and every real mode, and nothing else', () => {
    expect(isModeValue('')).toBe(true)
    for (const mode of APPROVAL_PERMISSION_MODES)
      expect(isModeValue(mode)).toBe(true)
    for (const bogus of ['bypassPermissions', 'plan', 'AUTO', ' auto'])
      expect(isModeValue(bogus)).toBe(false)
  })

  it('offers exactly the modes the server accepts, plus the keep-current option', () => {
    // A dropdown entry the server rejects would 400 the whole decision.
    expect(MODE_OPTIONS.map((option) => option.value)).toEqual([
      '',
      ...APPROVAL_PERMISSION_MODES,
    ])
  })
})
