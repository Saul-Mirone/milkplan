import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'

import {
  addMilkplanHook,
  isJsonObject,
  isMachineSpecific,
  removeMilkplanHooks,
  settingsRunMilkplan,
  type Settings,
} from '../src/cli/settings-hooks'
import type { DeepReadonly } from '../src/shared/readonly'

const OWN_COMMAND = 'npx -y @enorim/milkplan@0.1.0'
const CHECKOUT_COMMAND = '"/usr/local/bin/node" "/Users/x/Code/mp/dist/cli.mjs"'

function installed(): Settings {
  return addMilkplanHook({}, OWN_COMMAND).settings
}

function matchersOf(
  settings: DeepReadonly<Settings>,
  event: string,
): readonly unknown[] {
  const hooks = settings['hooks']
  if (!isJsonObject(hooks)) throw new Error('expected a hooks object')
  const matchers = hooks[event]
  if (!Array.isArray(matchers)) throw new Error(`expected ${event} matchers`)
  return matchers
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('addMilkplanHook', () => {
  it('creates the full hooks structure in empty settings', () => {
    const { settings, added } = addMilkplanHook({}, OWN_COMMAND)
    expect(added).toBe(true)
    expect(settings).toEqual({
      hooks: {
        PermissionRequest: [
          {
            matcher: 'ExitPlanMode',
            hooks: [{ type: 'command', command: OWN_COMMAND, timeout: 86400 }],
          },
        ],
      },
    })
  })

  it('is idempotent: a second add reports added=false and changes nothing', () => {
    const first = installed()
    const second = addMilkplanHook(first, OWN_COMMAND)
    expect(second.added).toBe(false)
    expect(second.settings).toEqual(first)
  })

  it('does not mutate its input', () => {
    const input: Settings = {}
    addMilkplanHook(input, OWN_COMMAND)
    expect(input).toEqual({})
  })

  it('recognizes a legacy milkplan entry with a different command format', () => {
    const legacy: Settings = {
      hooks: {
        PermissionRequest: [
          {
            matcher: 'ExitPlanMode',
            hooks: [
              {
                type: 'command',
                command: '"/opt/node/bin/node" "/home/x/milkplan/dist/cli.mjs"',
                timeout: 86400,
              },
            ],
          },
        ],
      },
    }
    expect(addMilkplanHook(legacy, OWN_COMMAND).added).toBe(false)
  })

  it('preserves unrelated events and matchers', () => {
    const input: Settings = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [] }],
        PermissionRequest: [
          {
            matcher: 'WebFetch',
            hooks: [{ type: 'command', command: 'other-tool' }],
          },
        ],
      },
    }
    const { settings, added } = addMilkplanHook(input, OWN_COMMAND)
    expect(added).toBe(true)
    expect(settings['permissions']).toEqual({ allow: ['Bash(ls:*)'] })
    expect(matchersOf(settings, 'PreToolUse')).toHaveLength(1)
    expect(matchersOf(settings, 'PermissionRequest')).toHaveLength(2)
  })
})

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('removeMilkplanHooks', () => {
  it('removes the installed entry and cleans up emptied structures', () => {
    const { settings, removed } = removeMilkplanHooks(installed())
    expect(removed).toBe(1)
    expect(settings).toEqual({})
  })

  it('does not mutate its input', () => {
    const input = installed()
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown
    removeMilkplanHooks(input)
    expect(input).toEqual(snapshot)
  })

  it('keeps non-milkplan hooks sharing the same matcher', () => {
    const input: Settings = {
      hooks: {
        PermissionRequest: [
          {
            matcher: 'ExitPlanMode',
            hooks: [
              { type: 'command', command: 'npx -y @enorim/milkplan' },
              { type: 'command', command: 'other-plan-tool' },
            ],
          },
        ],
      },
    }
    const { settings, removed } = removeMilkplanHooks(input)
    expect(removed).toBe(1)
    expect(settings).toEqual({
      hooks: {
        PermissionRequest: [
          {
            matcher: 'ExitPlanMode',
            hooks: [{ type: 'command', command: 'other-plan-tool' }],
          },
        ],
      },
    })
  })

  it('leaves other events untouched when removing the last matcher', () => {
    const input: Settings = {
      hooks: {
        PermissionRequest: [
          {
            matcher: 'ExitPlanMode',
            hooks: [{ type: 'command', command: OWN_COMMAND, timeout: 86400 }],
          },
        ],
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] },
        ],
      },
    }
    const { settings, removed } = removeMilkplanHooks(input)
    expect(removed).toBe(1)
    expect(settings).toEqual({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] },
        ],
      },
    })
  })

  it('removes stale absolute-path entries containing the milkplan substring', () => {
    const input: Settings = {
      hooks: {
        PermissionRequest: [
          {
            matcher: 'ExitPlanMode',
            hooks: [
              {
                type: 'command',
                command:
                  '"/Users/x/Library/Application Support/fnm/node" "/Users/x/Code/milkplan/dist/cli.mjs"',
              },
            ],
          },
        ],
      },
    }
    const { settings, removed } = removeMilkplanHooks(input)
    expect(removed).toBe(1)
    expect(settings).toEqual({})
  })

  it('returns 0 and changes nothing when milkplan is absent', () => {
    const input: Settings = {
      hooks: { PermissionRequest: [{ matcher: 'WebFetch', hooks: [] }] },
    }
    const { settings, removed } = removeMilkplanHooks(input)
    expect(removed).toBe(0)
    expect(settings).toEqual(input)
  })

  it('handles settings without hooks', () => {
    const { settings, removed } = removeMilkplanHooks({ permissions: {} })
    expect(removed).toBe(0)
    expect(settings).toEqual({ permissions: {} })
  })

  it('matches a checkout command without the milkplan substring via ownCommands', () => {
    const checkout = addMilkplanHook({}, CHECKOUT_COMMAND).settings
    expect(removeMilkplanHooks(checkout).removed).toBe(0)
    const { settings, removed } = removeMilkplanHooks(checkout, [
      CHECKOUT_COMMAND,
    ])
    expect(removed).toBe(1)
    expect(settings).toEqual({})
  })

  it('remove-then-add refreshes a stale entry to the new command', () => {
    const stale = addMilkplanHook(
      {},
      '"/old/node" "/old/milkplan/dist/cli.mjs"',
    ).settings
    const cleaned = removeMilkplanHooks(stale, [OWN_COMMAND])
    expect(cleaned.removed).toBe(1)
    const next = addMilkplanHook(cleaned.settings, OWN_COMMAND)
    expect(next.added).toBe(true)
    expect(next.settings).toEqual(installed())
  })
})

describe('settingsRunMilkplan', () => {
  it('detects an installed hook and honors ownCommands', () => {
    expect(settingsRunMilkplan(installed())).toBe(true)
    expect(settingsRunMilkplan({})).toBe(false)
    const anonymous = addMilkplanHook({}, CHECKOUT_COMMAND).settings
    expect(settingsRunMilkplan(anonymous)).toBe(false)
    expect(settingsRunMilkplan(anonymous, [CHECKOUT_COMMAND])).toBe(true)
  })
})

describe('isMachineSpecific', () => {
  it('accepts the portable npx command', () => {
    expect(isMachineSpecific('npx -y @enorim/milkplan@0.1.0')).toBe(false)
    expect(isMachineSpecific('npx -y @enorim/milkplan')).toBe(false)
  })

  it('accepts URLs (a drive-letter check must not match "s://")', () => {
    expect(
      isMachineSpecific(
        'npx -y @enorim/milkplan --registry https://registry.npmjs.org',
      ),
    ).toBe(false)
  })

  it('rejects POSIX absolute paths, quoted or bare', () => {
    expect(isMachineSpecific(CHECKOUT_COMMAND)).toBe(true)
    expect(isMachineSpecific('node /opt/milkplan/cli.mjs')).toBe(true)
    expect(isMachineSpecific('/usr/local/bin/milkplan')).toBe(true)
  })

  it('rejects Windows absolute paths', () => {
    expect(
      isMachineSpecific(
        '"C:\\Program Files\\nodejs\\node.exe" "D:\\x\\cli.mjs"',
      ),
    ).toBe(true)
    expect(isMachineSpecific('node C:/tools/milkplan/cli.mjs')).toBe(true)
  })

  it('rejects paths hidden behind =, ~, env vars, and UNC shares', () => {
    expect(isMachineSpecific('milkplan --plan-dir=/opt/plans')).toBe(true)
    expect(isMachineSpecific('node ~/Code/milkplan/dist/cli.mjs')).toBe(true)
    expect(isMachineSpecific('node $HOME/milkplan/cli.mjs')).toBe(true)
    expect(isMachineSpecific('node \\\\server\\share\\cli.mjs')).toBe(true)
  })

  it('rejects anything referencing the current home directory', () => {
    expect(isMachineSpecific(`node ${homedir()}/milkplan/cli.mjs`)).toBe(true)
  })
})
