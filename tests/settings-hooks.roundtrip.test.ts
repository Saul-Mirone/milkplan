import { describe, expect, it } from 'vitest'

import {
  addMilkplanHook,
  removeMilkplanHooks,
  type Settings,
} from '../src/cli/settings-hooks'

const OWN_COMMAND = 'npx -y milkplan@0.1.0'

function installed(): Settings {
  return addMilkplanHook({}, OWN_COMMAND).settings
}

describe('remove-then-add round trip', () => {
  it('restores the same content but moves "hooks" last when removal emptied it', () => {
    // This is why runInit compares settings with a key-order-insensitive
    // stringify. removeMilkplanHooks deletes an emptied `hooks` key and
    // addMilkplanHook re-appends it, so a plain JSON.stringify comparison
    // never matches: every `init` would rewrite the file, log "refreshed" for
    // a hook it did not change, and reorder the user's keys — a spurious git
    // diff on every run under --shared.
    const before: Settings = {
      permissions: { allow: ['Bash'] },
      ...installed(),
    }
    const cleaned = removeMilkplanHooks(before, [OWN_COMMAND])
    const after = addMilkplanHook(cleaned.settings, OWN_COMMAND).settings

    expect(after).toEqual(before)
    expect(Object.keys(before)).toEqual(['permissions', 'hooks'])
    expect(Object.keys(after)).toEqual(['permissions', 'hooks'])
  })

  it('moves "hooks" to the end when it held nothing but the milkplan entry', () => {
    const before: Settings = {
      ...installed(),
      permissions: { allow: ['Bash'] },
    }
    const cleaned = removeMilkplanHooks(before, [OWN_COMMAND])
    const after = addMilkplanHook(cleaned.settings, OWN_COMMAND).settings

    expect(after).toEqual(before)
    expect(Object.keys(before)).toEqual(['hooks', 'permissions'])
    // The reorder itself: same content, different key order.
    expect(Object.keys(after)).toEqual(['permissions', 'hooks'])
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before))
  })
})
