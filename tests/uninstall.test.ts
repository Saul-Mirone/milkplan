import { describe, expect, it } from 'vitest'

import { runUninstall } from '../src/cli/uninstall'
import { addMilkplanHook, type Settings } from '../src/cli/settings-hooks'
import type { DeepReadonly } from '../src/shared/readonly'
import {
  at,
  fakeInitIO,
  logged,
  HOME,
  NODE,
  PROJECT,
  type Written,
} from './helpers/fake-init-io'

const USER_SETTINGS = `${HOME}/.claude/settings.json`
const PROJECT_SHARED = `${PROJECT}/.claude/settings.json`
const PROJECT_LOCAL = `${PROJECT}/.claude/settings.local.json`

/** What a checkout install writes, given the fake's paths. */
const CHECKOUT_COMMAND = `"${NODE}" "/Users/dev/Code/milkplan/dist/cli.mjs"`

function installedWith(command: string): string {
  return JSON.stringify(addMilkplanHook({}, command).settings, null, 2)
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('runUninstall', () => {
  it('cleans the user file and both project files, reporting each one', () => {
    const fake = fakeInitIO({
      files: {
        [USER_SETTINGS]: installedWith('npx -y milkplan'),
        [PROJECT_SHARED]: installedWith('npx -y milkplan@0.1.0'),
        [PROJECT_LOCAL]: installedWith(CHECKOUT_COMMAND),
      },
    })
    runUninstall([], fake.io)

    expect(
      fake.state.writes.map((write: DeepReadonly<Written>) => write.path),
    ).toEqual([USER_SETTINGS, PROJECT_SHARED, PROJECT_LOCAL])
    for (const path of [USER_SETTINGS, PROJECT_SHARED, PROJECT_LOCAL])
      expect(fake.settingsAt(path)).toEqual({})
    expect(logged(fake.state, 'npm uninstall -g milkplan')).toBe(true)
    // Uninstall leaves the plan history behind; the user must at least be
    // told where it lives.
    expect(logged(fake.state, '~/.claude/milkplan/history/')).toBe(true)
  })

  it('removes a checkout hook whose path never mentions milkplan', () => {
    // A checkout in a directory not named "milkplan" produces a command the
    // substring match cannot see; ownCommands is the only thing that catches
    // it, and missing it leaves a dead hook firing on every plan approval.
    const anonymous =
      '"/usr/local/bin/node" "/Users/dev/Code/widget/dist/cli.mjs"'
    const fake = fakeInitIO({
      selfPath: '/Users/dev/Code/widget/dist/cli.mjs',
      files: { [USER_SETTINGS]: installedWith(anonymous) },
    })
    runUninstall([], fake.io)

    expect(fake.settingsAt(USER_SETTINGS)).toEqual({})
  })

  it('leaves a co-resident third-party hook on the same matcher intact', () => {
    const shared: Settings = {
      hooks: {
        PermissionRequest: [
          {
            matcher: 'ExitPlanMode',
            hooks: [
              { type: 'command', command: 'npx -y milkplan' },
              { type: 'command', command: 'other-plan-tool' },
            ],
          },
        ],
      },
    }
    const fake = fakeInitIO({
      files: { [USER_SETTINGS]: JSON.stringify(shared) },
    })
    runUninstall([], fake.io)

    expect(
      at(
        fake.settingsAt(USER_SETTINGS),
        'hooks',
        'PermissionRequest',
        0,
        'hooks',
      ),
    ).toEqual([{ type: 'command', command: 'other-plan-tool' }])
  })

  it('keeps cleaning the other files after one turns out to be unparseable', () => {
    // `continue`, not `return`: a broken project file must not strand a
    // milkplan hook in the user's settings.
    const fake = fakeInitIO({
      files: {
        [USER_SETTINGS]: '{ not json',
        [PROJECT_LOCAL]: installedWith(CHECKOUT_COMMAND),
      },
    })
    runUninstall([], fake.io)

    expect(
      fake.state.writes.map((write: DeepReadonly<Written>) => write.path),
    ).toEqual([PROJECT_LOCAL])
    expect(fake.settingsAt(PROJECT_LOCAL)).toEqual({})
    expect(fake.state.failed).toBe(true)
  })

  it('explains the unparseable file rather than claiming nothing was installed', () => {
    const fake = fakeInitIO({ files: { [USER_SETTINGS]: '{ not json' } })
    runUninstall([], fake.io)

    expect(fake.state.writes).toEqual([])
    expect(logged(fake.state, 'could not be parsed')).toBe(true)
    expect(logged(fake.state, 'no milkplan hooks found in')).toBe(false)
  })

  it('rewrites nothing when no file holds a milkplan hook', () => {
    // Rewriting would reformat settings the user hand-edited, for no reason.
    const original = JSON.stringify({ permissions: { allow: ['Bash'] } })
    const fake = fakeInitIO({ files: { [USER_SETTINGS]: original } })
    runUninstall([], fake.io)

    expect(fake.state.writes).toEqual([])
    expect(fake.state.files.get(USER_SETTINGS)).toBe(original)
    expect(logged(fake.state, 'no milkplan hooks found in')).toBe(true)
    expect(logged(fake.state, 'run uninstall from the project root')).toBe(true)
  })

  it('lists each candidate once when the project directory is the home directory', () => {
    // The de-duplication matters for the report: naming the same file three
    // times reads like three separate misses.
    const fake = fakeInitIO({ home: HOME, cwd: HOME })
    runUninstall([], fake.io)

    const listing = fake.state.logs.find((line) =>
      line.includes('no milkplan hooks found in'),
    )
    expect(listing?.match(/settings\.json/gu)).toHaveLength(1)
    expect(listing?.match(/settings\.local\.json/gu)).toHaveLength(1)
  })

  it('rejects any argument, since uninstall takes none', () => {
    const fake = fakeInitIO({
      files: { [USER_SETTINGS]: installedWith('npx -y milkplan') },
    })
    runUninstall(['--all'], fake.io)

    expect(fake.state.writes).toEqual([])
    expect(fake.state.failed).toBe(true)
    expect(logged(fake.state, 'unknown option for uninstall')).toBe(true)
  })
})
