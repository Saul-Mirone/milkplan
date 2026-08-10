// `changeset version` only edits package.json, but the release identity is
// restated in two places no import can reach: the version-pinned hook command
// the README documents for `milkplan init --project --shared`, and the plugin
// manifest's `version`. Both have to move with the release.
// Run from the repo root, immediately after `changeset version`.
import { readFileSync, writeFileSync } from 'node:fs'

// Default import, not named: unlike the bundled src/cli/version.ts, this runs
// on raw Node ESM, where a JSON module exposes only a default export.
import manifest from '../package.json' with { type: 'json' }

const readmeUrl = new URL('../README.md', import.meta.url)
const pluginUrl = new URL('../.claude-plugin/plugin.json', import.meta.url)

const { name, version } = manifest
if (typeof name !== 'string' || typeof version !== 'string' || version === '') {
  throw new Error('package.json is missing name or version')
}

// Narrow on purpose: the digit-free `@enorim/milkplan@<version>` placeholder in
// the prose above it must not be touched.
const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const pinned = new RegExp(`${escaped}@\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?`, 'gu')

const before = readFileSync(readmeUrl, 'utf8')
if (before.match(pinned) === null) {
  throw new Error(`no pinned ${name}@<version> found in README.md`)
}
const after = before.replace(pinned, `${name}@${version}`)
if (after !== before) {
  writeFileSync(readmeUrl, after)
  process.stdout.write(`sync-version: README.md -> ${name}@${version}\n`)
}

// The plugin manifest's version is the ONLY thing Claude Code can use as an
// update signal here: version resolution falls back to a source commit SHA for
// git-backed plugin sources, but an npm source with no version anywhere
// resolves to the literal string "unknown" — a constant, so `/plugin update`
// would never see a new release. A missing field is therefore a release bug,
// not something to paper over by inserting one.
// Rewritten in place rather than parsed and re-serialized: this keeps $schema,
// key order, and formatting exactly as committed, so the release commit shows
// one changed line instead of a reshuffled manifest.
const versionField = /("version"\s*:\s*")\d+\.\d+\.\d+(?:-[\w.]+)?(")/u
const pluginBefore = readFileSync(pluginUrl, 'utf8')
if (!versionField.test(pluginBefore)) {
  throw new Error('no version field found in .claude-plugin/plugin.json')
}
const pluginAfter = pluginBefore.replace(versionField, `$1${version}$2`)
if (pluginAfter !== pluginBefore) {
  writeFileSync(pluginUrl, pluginAfter)
  process.stdout.write(`sync-version: plugin.json -> ${version}\n`)
}
