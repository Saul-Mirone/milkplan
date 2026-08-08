import { access, constants, readFile, stat } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'

import { VERSION } from '../src/cli/version'
import { CLI, requireBuiltCli } from './helpers/cli-process'
import { at } from './helpers/json'

const PACKAGE_JSON = new URL('../package.json', import.meta.url)

beforeAll(requireBuiltCli)

describe('the published bundle', () => {
  it('starts with a node shebang, since package.json exposes it as a bin', () => {
    // npm links bin entries as executables; without the shebang the shell
    // tries to run JavaScript as a shell script and `milkplan` dies on the
    // first line for anyone who installed globally.
    return readFile(CLI, 'utf8').then((source) => {
      expect(source.startsWith('#!/usr/bin/env node')).toBe(true)
    })
  })

  it('carries the executable bit', async () => {
    await expect(access(CLI, constants.X_OK)).resolves.toBeUndefined()
    const stats = await stat(CLI)
    expect(stats.mode & 0o111).not.toBe(0)
  })

  it('is the file package.json points bin.milkplan at', async () => {
    // A renamed entry point publishes a package whose only command is missing.
    const manifest: unknown = JSON.parse(await readFile(PACKAGE_JSON, 'utf8'))
    const target = at(manifest, 'bin', 'milkplan')
    expect(target).toBe('dist/cli.mjs')

    const resolved = new URL(`../${String(target)}`, import.meta.url)
    await expect(access(resolved, constants.R_OK)).resolves.toBeUndefined()
  })

  it('ships the UI assets the server serves next to the bundle', async () => {
    // hook-io resolves ./ui relative to the bundle; publishing without it
    // yields a review page that 404s into the SPA fallback forever.
    const index = new URL('../dist/ui/index.html', import.meta.url)
    await expect(access(index, constants.R_OK)).resolves.toBeUndefined()
  })

  it('reports the same version the source constant claims', async () => {
    // The constant is what --shared pins for a whole team; a stale one would
    // pin teammates to a version that does not exist yet.
    const manifest: unknown = JSON.parse(await readFile(PACKAGE_JSON, 'utf8'))
    expect(VERSION).toBe(at(manifest, 'version'))
  })
})
