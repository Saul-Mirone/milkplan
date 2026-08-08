import { describe, expect, it } from 'vitest'

import {
  APPROVAL_PERMISSION_MODES,
  TOKEN_HEADER,
  type ApprovalPermissionMode,
} from '../src/shared/protocol'

/**
 * Adding a member to the union makes this object fail to typecheck until the
 * new mode is listed here; comparing its keys against the exported array then
 * fails at runtime until the array is updated too. TypeScript alone cannot
 * catch that drift: `readonly ApprovalPermissionMode[]` is perfectly happy to
 * be missing a member.
 */
const EVERY_MODE: Record<ApprovalPermissionMode, true> = {
  auto: true,
  acceptEdits: true,
  default: true,
}

describe('APPROVAL_PERMISSION_MODES', () => {
  it('lists exactly the ApprovalPermissionMode union, which is what the server validates against', () => {
    // server.ts rejects any permissionMode outside this array with a 400, so a
    // mode present in the type but missing here is silently unusable from the
    // UI — the approval goes through with the session's mode unchanged.
    expect([...APPROVAL_PERMISSION_MODES].sort()).toEqual(
      Object.keys(EVERY_MODE).sort(),
    )
  })

  it('has no duplicates', () => {
    expect(new Set(APPROVAL_PERMISSION_MODES).size).toBe(
      APPROVAL_PERMISSION_MODES.length,
    )
  })
})

describe('TOKEN_HEADER', () => {
  it('is lowercase, because node lowercases incoming header names before the server compares them', () => {
    // server.ts reads req.headers[TOKEN_HEADER] directly. A capitalized
    // constant would never match, and every single /api request would 403 —
    // the review UI would load and then fail on its first fetch.
    expect(TOKEN_HEADER).toBe(TOKEN_HEADER.toLowerCase())
  })
})
