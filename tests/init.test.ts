import { describe, expect, it } from 'vitest'

import { hookCommandFor, runInit } from '../src/cli/init'
import { isMachineSpecific } from '../src/cli/settings-hooks'
import { VERSION } from '../src/cli/version'
import {
  at,
  fakeInitIO,
  logged,
  HOME,
  NODE,
  PROJECT,
  SELF_CHECKOUT,
  SELF_DIST,
  SELF_NPM,
} from './helpers/fake-init-io'

const USER_SETTINGS = `${HOME}/.claude/settings.json`
const PROJECT_LOCAL = `${PROJECT}/.claude/settings.local.json`
const PROJECT_SHARED = `${PROJECT}/.claude/settings.json`

/** The command a checkout install registers, given the fake's paths. */
const CHECKOUT_COMMAND = `"${NODE}" "/Users/dev/Code/milkplan/dist/cli.mjs"`

function commandIn(settings: unknown): unknown {
  return at(settings, 'hooks', 'PermissionRequest', 0, 'hooks', 0, 'command')
}

describe('hookCommandFor', () => {
  it('quotes the interpreter and the script so a node under "Application Support" survives the shell', () => {
    // Hook commands run through a shell, and fnm puts node under
    // ~/Library/Application Support on macOS. Unquoted, the shell splits at
    // the space and runs "/Users/x/Library/Application" — every plan approval
    // then fails silently and the review never opens.
    const fnmNode =
      '/Users/dev/Library/Application Support/fnm/node-versions/v24.0.0/installation/bin/node'
    const command = hookCommandFor(SELF_DIST, fnmNode)
    expect(command).toBe(`"${fnmNode}" "${SELF_DIST}"`)
    // Exactly two quoted spans; losing one pair would still pass a toContain.
    expect(command.split('"')).toHaveLength(5)
  })

  it('picks npx for an npm install, the built bundle for a checkout, and never the TypeScript source', () => {
    // node cannot execute src/cli/init.ts, and a bundle inside node_modules is
    // reachable portably through npx — getting either branch wrong registers a
    // hook that is dead on arrival.
    expect(hookCommandFor(SELF_NPM, NODE)).toBe('npx -y milkplan')
    expect(hookCommandFor(SELF_DIST, NODE)).toBe(`"${NODE}" "${SELF_DIST}"`)
    expect(hookCommandFor(SELF_CHECKOUT, NODE)).toBe(CHECKOUT_COMMAND)
  })
})

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('runInit', () => {
  it('registers the hook in the user settings file with the 24h timeout Claude Code needs', () => {
    const fake = fakeInitIO()
    runInit([], fake.io)

    expect(fake.onlyWrite().path).toBe(USER_SETTINGS)
    expect(fake.settingsAt(USER_SETTINGS)).toEqual({
      hooks: {
        PermissionRequest: [
          {
            matcher: 'ExitPlanMode',
            hooks: [
              {
                type: 'command',
                command: CHECKOUT_COMMAND,
                timeout: 86400,
              },
            ],
          },
        ],
      },
    })
    expect(fake.state.failed).toBe(false)
  })

  it('sends a --project install to settings.local.json and never to the committed file', () => {
    // The command embeds absolute paths from this machine; settings.json is
    // the file teammates get.
    const fake = fakeInitIO()
    runInit(['--project'], fake.io)

    expect(fake.onlyWrite().path).toBe(PROJECT_LOCAL)
    expect(fake.state.files.has(PROJECT_SHARED)).toBe(false)
  })

  it('writes only the version-pinned npx command under --project --shared, and touches no git', () => {
    const fake = fakeInitIO({ selfPath: SELF_NPM })
    runInit(['--project', '--shared'], fake.io)

    expect(fake.onlyWrite().path).toBe(PROJECT_SHARED)
    const command = commandIn(fake.settingsAt(PROJECT_SHARED))
    expect(command).toBe(`npx -y milkplan@${VERSION}`)
    expect(isMachineSpecific(String(command))).toBe(false)
    // A shared install is not machine-local, so nothing should be excluded.
    expect(fake.state.gitCalls).toEqual([])
    expect(fake.state.appends).toEqual([])
  })

  it('refuses a shared install from a source checkout without creating or writing anything', () => {
    // Falling through here would commit one developer's absolute paths into
    // the team's settings.json and break the hook for everyone else.
    const fake = fakeInitIO({ selfPath: SELF_CHECKOUT })
    runInit(['--project', '--shared'], fake.io)

    expect(fake.state.writes).toEqual([])
    expect(fake.state.mkdirs).toEqual([])
    expect(fake.state.failed).toBe(true)
    expect(logged(fake.state, 'source checkout')).toBe(true)
    // The remedy line is the user's only route forward.
    expect(logged(fake.state, 'npm install -g milkplan')).toBe(true)
  })

  it('rejects --shared without --project, and any unknown option, writing nothing', () => {
    for (const args of [['--shared'], ['--porject'], ['--project', '-f']]) {
      const fake = fakeInitIO()
      runInit(args, fake.io)
      expect({
        args,
        writes: fake.state.writes,
        failed: fake.state.failed,
      }).toEqual({ args, writes: [], failed: true })
    }
  })

  it('keeps every unrelated settings key and hook event across the read-merge-write round trip', () => {
    // Nothing else proves runInit serializes the merged object rather than a
    // fragment of it; a regression here silently wipes the user's whole Claude
    // Code configuration.
    const existing = {
      permissions: { allow: ['Bash(ls:*)'] },
      env: { FOO: 'bar' },
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
    const fake = fakeInitIO({
      files: { [USER_SETTINGS]: JSON.stringify(existing, null, 2) },
    })
    runInit([], fake.io)

    const next = fake.settingsAt(USER_SETTINGS)
    expect(at(next, 'permissions')).toEqual(existing.permissions)
    expect(at(next, 'env')).toEqual(existing.env)
    expect(at(next, 'hooks', 'PreToolUse')).toEqual(existing.hooks.PreToolUse)
    expect(at(next, 'hooks', 'PermissionRequest')).toHaveLength(2)
  })

  it('writes 2-space JSON with a trailing newline, because settings files are hand-edited', () => {
    const fake = fakeInitIO()
    runInit([], fake.io)

    const { content } = fake.onlyWrite()
    expect(content.endsWith('\n')).toBe(true)
    expect(content).toContain('\n  "hooks"')
    expect(content).not.toContain('\t')
  })

  it('refuses to overwrite a settings file it cannot parse as a JSON object', () => {
    for (const raw of ['{ not json', '[]', 'null', '"a string"']) {
      const fake = fakeInitIO({ files: { [USER_SETTINGS]: raw } })
      runInit([], fake.io)
      expect({
        raw,
        writes: fake.state.writes,
        failed: fake.state.failed,
      }).toEqual({ raw, writes: [], failed: true })
      // The original bytes must survive untouched.
      expect(fake.state.files.get(USER_SETTINGS)).toBe(raw)
    }
  })

  it('reports nothing to do on a re-run, leaving the file byte-identical', () => {
    const fake = fakeInitIO()
    runInit([], fake.io)
    const afterFirst = fake.state.files.get(USER_SETTINGS)

    runInit([], fake.io)

    expect(fake.state.writes).toHaveLength(1)
    expect(fake.state.files.get(USER_SETTINGS)).toBe(afterFirst)
    expect(logged(fake.state, 'nothing to do')).toBe(true)
  })

  it('recognizes an unchanged install even when "hooks" is not the last key', () => {
    // The load-bearing case. removeMilkplanHooks deletes an emptied `hooks`
    // key and addMilkplanHook re-appends it at the end, so a key-order
    // sensitive comparison never matches a file that lists `hooks` first —
    // which is most real settings.json files. Every `init` then rewrote the
    // file, logged "refreshed hook" for a hook it had not changed, and
    // reordered the user's keys: a spurious git diff on every run under
    // --shared.
    const raw = `${JSON.stringify(
      {
        hooks: {
          PermissionRequest: [
            {
              matcher: 'ExitPlanMode',
              hooks: [
                {
                  type: 'command',
                  command: CHECKOUT_COMMAND,
                  timeout: 86400,
                },
              ],
            },
          ],
        },
        permissions: { allow: ['Bash'] },
      },
      null,
      2,
    )}\n`
    const fake = fakeInitIO({ files: { [USER_SETTINGS]: raw } })

    runInit([], fake.io)

    expect(fake.state.writes).toEqual([])
    expect(fake.state.files.get(USER_SETTINGS)).toBe(raw)
    expect(logged(fake.state, 'nothing to do')).toBe(true)
    expect(logged(fake.state, 'refreshed hook')).toBe(false)
  })

  it('refreshes a stale entry into exactly one hook rather than stacking a second', () => {
    const stale = {
      hooks: {
        PermissionRequest: [
          {
            matcher: 'ExitPlanMode',
            hooks: [
              {
                type: 'command',
                command: '"/old/node" "/old/milkplan/dist/cli.mjs"',
                timeout: 86400,
              },
            ],
          },
        ],
      },
    }
    const fake = fakeInitIO({
      files: { [USER_SETTINGS]: JSON.stringify(stale) },
    })
    runInit([], fake.io)

    const next = fake.settingsAt(USER_SETTINGS)
    expect(at(next, 'hooks', 'PermissionRequest')).toHaveLength(1)
    expect(at(next, 'hooks', 'PermissionRequest', 0, 'hooks')).toHaveLength(1)
    expect(commandIn(next)).toBe(CHECKOUT_COMMAND)
    expect(logged(fake.state, 'refreshed hook')).toBe(true)
  })

  it('warns when a sibling settings file also runs milkplan, since hooks stack', () => {
    // selfPath must be the npm install: from a checkout, --shared bails before
    // the warning is ever reached and the test would pass vacuously.
    const fake = fakeInitIO({
      selfPath: SELF_NPM,
      files: {
        [USER_SETTINGS]: JSON.stringify({
          hooks: {
            PermissionRequest: [
              {
                matcher: 'ExitPlanMode',
                hooks: [{ type: 'command', command: 'npx -y milkplan' }],
              },
            ],
          },
        }),
      },
    })
    runInit(['--project', '--shared'], fake.io)

    expect(logged(fake.state, 'also runs milkplan')).toBe(true)
    expect(logged(fake.state, 'would open two reviews')).toBe(true)
  })

  it('stays quiet when the sibling settings file has no milkplan hook', () => {
    const fake = fakeInitIO({
      selfPath: SELF_NPM,
      files: { [USER_SETTINGS]: JSON.stringify({ permissions: {} }) },
    })
    runInit(['--project', '--shared'], fake.io)

    expect(logged(fake.state, 'also runs milkplan')).toBe(false)
  })
})
