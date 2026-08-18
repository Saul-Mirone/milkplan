import { access, constants, readdir, readFile, stat } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'

import { PACKAGE_NAME, VERSION } from '../src/cli/version'
import { CLI, requireBuiltCli } from './helpers/cli-process'
import { at } from './helpers/json'

const PACKAGE_JSON = '../package.json'
const PLUGIN_JSON = '../.claude-plugin/plugin.json'
const MARKETPLACE_JSON = '../.claude-plugin/marketplace.json'
const HOOKS_JSON = '../hooks/hooks.json'
const README = new URL('../README.md', import.meta.url)
// The last release whose tarball carried no plugin manifests.
const PLUGINLESS = [0, 0, 1]
// Deliberately digit-anchored: the README also carries a `@<version>`
// placeholder in prose, which the sync script leaves alone.
const PINNED_COMMAND = /@enorim\/milkplan@\d+\.\d+\.\d+(?:-[\w.]+)?/gu

beforeAll(requireBuiltCli)

async function readJson(specifier: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(specifier, import.meta.url), 'utf8'))
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
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
    const manifest = await readJson(PACKAGE_JSON)
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

  it('ships the rule hiding the diff Accept/Reject controls in the overlay', async () => {
    // Load-bearing canary: the diff overlay is read-only ONLY because this
    // rule hides the per-chunk controls, which the diff component renders
    // unconditionally with no config switch. Asserting on the bare
    // `milkdown-diff-controls` class proves nothing — the component's own
    // stylesheet already ships that name.
    const assets = new URL('../dist/ui/assets/', import.meta.url)
    const names = await readdir(assets)
    const cssName = names.find((name) => /^index-.*\.css$/u.test(name))
    expect(cssName).toBeDefined()

    const css = await readFile(new URL(String(cssName), assets), 'utf8')
    expect(css).toContain('.mp-diff-overlay .milkdown .milkdown-diff-controls')
  })

  it('ships light-dark() intact rather than a prefers-color-scheme polyfill', async () => {
    // Load-bearing canary. Every themed color — the app palette, the vendored
    // Crepe palette, and shiki's code-block tokens — is a `light-dark()` so
    // that `color-scheme` on <html> is the single switch the theme toggle can
    // move. Under Vite's default baseline cssTarget, Lightning CSS downlevels
    // `light-dark()` into --lightningcss-* vars gated on a
    // (prefers-color-scheme: dark) media query, which answers to the OS alone:
    // the source stays correct, `pnpm dev` stays correct, and the published
    // bundle silently ignores the toggle. vite.config.ts raises cssTarget to
    // stop that; this proves it is still raised.
    const assets = new URL('../dist/ui/assets/', import.meta.url)
    const names = await readdir(assets)
    const cssName = names.find((name) => /^index-.*\.css$/u.test(name))
    expect(cssName).toBeDefined()

    const css = await readFile(new URL(String(cssName), assets), 'utf8')
    expect(css).toContain('light-dark(')
    expect(css).not.toContain('lightningcss-light')
    expect(css).not.toContain('prefers-color-scheme')
  })

  it('documents the current version in the pinned hook example', async () => {
    // README shows the exact JSON `init --project --shared` commits for a whole
    // team, and it is the one copy of the release identity no import can reach
    // — scripts/sync-readme-pin.mjs moves it, this proves the move happened.
    const readme = await readFile(README, 'utf8')
    const pins = new Set<string>()
    for (const match of readme.matchAll(PINNED_COMMAND)) pins.add(match[0])
    expect(pins.size).toBeGreaterThan(0)
    expect([...pins]).toEqual([`${PACKAGE_NAME}@${VERSION}`])
  })
})

describe('the plugin manifest', () => {
  it('carries the released version', async () => {
    // For an npm plugin source this field is the ONLY update signal: version
    // resolution falls back to a commit SHA for git-backed sources, but an npm
    // source with no version anywhere resolves to the constant "unknown", so
    // `/plugin update` would never see a release. scripts/sync-version.mjs
    // moves it; this proves the move happened.
    const plugin = await readJson(PLUGIN_JSON)
    expect(at(plugin, 'name')).toBe('milkplan')
    expect(at(plugin, 'version')).toBe(VERSION)
  })

  it('registers the review hook against the shipped bundle', async () => {
    // The path lives in a string no import can reach, so renaming the bundle
    // entry point would otherwise surface on a user's first plan approval.
    const hooks = await readJson(HOOKS_JSON)
    const matcher = at(hooks, 'hooks', 'PermissionRequest', 0)
    expect(at(matcher, 'matcher')).toBe('ExitPlanMode')

    const entry = at(matcher, 'hooks', 0)
    expect(at(entry, 'type')).toBe('command')
    // Same budget the settings.json hook init writes uses.
    expect(at(entry, 'timeout')).toBe(86400)

    const command = String(at(entry, 'command'))
    const target = /\$\{CLAUDE_PLUGIN_ROOT\}([^"']+)/u.exec(command)
    expect(target).not.toBeNull()
    const resolved = new URL(`..${String(target?.[1])}`, import.meta.url)
    await expect(access(resolved, constants.R_OK)).resolves.toBeUndefined()
  })

  it('is published in the tarball, dot-directory and all', async () => {
    // npm drops dot-prefixed entries unless `files` names them explicitly, and
    // a marketplace `npm` source resolves the plugin from the tarball alone —
    // omit either entry and the install yields a plugin that does nothing.
    const manifest = await readJson(PACKAGE_JSON)
    expect(at(manifest, 'files')).toEqual(
      expect.arrayContaining(['dist', 'hooks', '.claude-plugin/plugin.json']),
    )
  })
})

describe('the marketplace catalog', () => {
  it('lists the plugin as milkplan@enorim, sourced from npm', async () => {
    // The id is `plugin-name@marketplace-name` — the reverse of npm's scope
    // order, and the pair these two names spell out.
    const marketplace = await readJson(MARKETPLACE_JSON)
    expect(at(marketplace, 'name')).toBe('enorim')
    expect(at(marketplace, 'owner', 'name')).toBe('Saul-Mirone')

    const entry = at(marketplace, 'plugins', 0)
    expect(at(entry, 'name')).toBe('milkplan')
    expect(at(entry, 'source', 'source')).toBe('npm')
    expect(at(entry, 'source', 'package')).toBe(PACKAGE_NAME)
    // Setting it here too would mask plugin.json's, which always wins.
    expect(at(entry, 'version')).toBeUndefined()
  })

  it('floors the npm range above the plugin-less releases', async () => {
    // 0.0.1 predates the plugin manifests: its tarball resolves as a plugin
    // with no components, so it installs and then silently does nothing. The
    // floor is the only thing holding it out of reach.
    //
    // Asserting the `>=` form matters as much as the number. A caret reads as
    // the same intent and is not: per semver `^0.0.2` means `>=0.0.2 <0.0.3`,
    // so it would match that one release and pin every user to it forever.
    const marketplace = await readJson(MARKETPLACE_JSON)
    const range = String(at(marketplace, 'plugins', 0, 'source', 'version'))
    const floor = /^>=(\d+)\.(\d+)\.(\d+)$/u.exec(range)
    expect(floor).not.toBeNull()

    const parts = [1, 2, 3].map((field) => Number(floor?.[field]))
    // First differing field decides, the way semver reads it — a string or
    // array compare would call 0.0.10 the older one.
    const field = parts.findIndex((part, index) => part !== PLUGINLESS[index])
    expect(field).toBeGreaterThanOrEqual(0)
    expect(Number(parts[field])).toBeGreaterThan(Number(PLUGINLESS[field]))
  })
})
