// .tsx only to land in the dom vitest project (happy-dom provides a working
// localStorage); the suite renders nothing.
import { afterEach, describe, expect, it } from 'vitest'

import {
  DRAFT_TTL_MS,
  clearDraft,
  hashPlan,
  pruneDrafts,
  readDraft,
  writeDraft,
} from '../../src/ui/draft'
import { makeDraft } from '../helpers/draft-fixtures'

const PLAN = '# Plan'
const SESSION = 'session-1'

afterEach(() => {
  localStorage.clear()
})

describe('draft storage round-trip', () => {
  it('writes and reads back a draft for the same session and plan', () => {
    const draft = makeDraft()
    writeDraft(SESSION, draft)
    expect(readDraft(SESSION, PLAN)).toEqual(draft)
  })

  it('ignores a draft captured against a different plan', () => {
    writeDraft(SESSION, makeDraft())
    expect(readDraft(SESSION, '# Plan v2 — a later round')).toBeNull()
  })

  it('scopes drafts by session id', () => {
    writeDraft(SESSION, makeDraft())
    expect(readDraft('session-2', PLAN)).toBeNull()
  })

  it('clearDraft removes only this session entry', () => {
    writeDraft(SESSION, makeDraft())
    writeDraft('session-2', makeDraft())
    clearDraft(SESSION)
    expect(readDraft(SESSION, PLAN)).toBeNull()
    expect(readDraft('session-2', PLAN)).not.toBeNull()
  })
})

describe('pruneDrafts', () => {
  it('removes expired and corrupt drafts, keeps fresh ones and foreign keys', () => {
    const now = 1_700_000_000_000
    writeDraft('fresh', makeDraft({ savedAt: now - 1000 }))
    writeDraft('expired', makeDraft({ savedAt: now - DRAFT_TTL_MS - 1 }))
    localStorage.setItem('milkplan:draft:corrupt', 'not json')
    localStorage.setItem('milkplan:theme', 'dark')

    pruneDrafts(now)

    expect(readDraft('fresh', PLAN)).not.toBeNull()
    expect(localStorage.getItem('milkplan:draft:expired')).toBeNull()
    expect(localStorage.getItem('milkplan:draft:corrupt')).toBeNull()
    expect(localStorage.getItem('milkplan:theme')).toBe('dark')
  })

  it('keeps a draft exactly at the TTL boundary', () => {
    const now = 1_700_000_000_000
    writeDraft(SESSION, makeDraft({ savedAt: now - DRAFT_TTL_MS }))
    pruneDrafts(now)
    expect(readDraft(SESSION, PLAN)).not.toBeNull()
  })

  it('hashPlan guard means a stale-round draft dies on read, not on write', () => {
    // Round 1 leaves a draft; round 2 serves a different plan text.
    writeDraft(SESSION, makeDraft({ planHash: hashPlan('old plan') }))
    expect(readDraft(SESSION, PLAN)).toBeNull()
  })
})
