// `changeset version` only edits package.json. The README documents the
// version-pinned hook command `milkplan init --project --shared` writes into a
// team's committed settings, and that pin has to move with the release.
// Run from the repo root, immediately after `changeset version`.
import { readFileSync, writeFileSync } from 'node:fs'

// Default import, not named: unlike the bundled src/cli/version.ts, this runs
// on raw Node ESM, where a JSON module exposes only a default export.
import manifest from '../package.json' with { type: 'json' }

const readmeUrl = new URL('../README.md', import.meta.url)

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
  process.stdout.write(`sync-readme-pin: README.md -> ${name}@${version}\n`)
}
