import { describe, expect, it } from 'vitest'

import { canonicalizeMarkdown } from '../src/cli/canonical'

/**
 * Every plan round and every write-back passes through canonicalizeMarkdown so
 * that two rounds differ only where their content differs. These cases pin the
 * canon itself (which style wins) and the invariants the diff overlay leans on:
 * idempotence, and total pass-through on input remark cannot handle.
 */
describe('canonicalizeMarkdown — the canon', () => {
  it('rewrites bullets to -, emphasis to _, and leaves strong as **', () => {
    expect(
      canonicalizeMarkdown('* one\n* two\n\nSome *em* and **strong**.'),
    ).toBe('- one\n- two\n\nSome _em_ and **strong**.')
  })

  it('renumbers ordered lists sequentially', () => {
    // Claude writes these both ways; without renumbering, "3." vs "2." is a
    // node-attr difference on every later item.
    expect(canonicalizeMarkdown('1. a\n3. b\n7. c')).toBe('1. a\n2. b\n3. c')
  })

  it('preserves tight and loose list spacing', () => {
    expect(canonicalizeMarkdown('- a\n- b')).toBe('- a\n- b')
    expect(canonicalizeMarkdown('- a\n\n- b')).toBe('- a\n\n- b')
  })

  it('trims surrounding blank lines', () => {
    expect(canonicalizeMarkdown('\n\n# Plan\n\n\n')).toBe('# Plan')
  })
})

describe('canonicalizeMarkdown — content it must not damage', () => {
  it('round-trips a GFM table', () => {
    const table = '| a | b |\n| - | - |\n| 1 | 2 |'
    expect(canonicalizeMarkdown(table)).toBe(table)
  })

  it('round-trips a GFM task list', () => {
    const tasks = '- [ ] todo\n- [x] done'
    expect(canonicalizeMarkdown(tasks)).toBe(tasks)
  })

  it('passes YAML frontmatter through instead of reading --- as a rule', () => {
    expect(canonicalizeMarkdown('---\ntitle: x\n---\n\n# Plan')).toBe(
      '---\ntitle: x\n---\n\n# Plan',
    )
  })

  it('leaves code block contents byte-identical', () => {
    // The canon rewrites markdown syntax, and `1 * 2` inside a fence is not
    // markdown syntax.
    const fenced = '```ts\nconst x = 1 * 2\n```'
    expect(canonicalizeMarkdown(fenced)).toBe(fenced)
  })
})

describe('canonicalizeMarkdown — invariants', () => {
  it('is idempotent', () => {
    const src = '* a\n\n1. x\n3. y\n\nSome *em*.\n\n| a | b |\n| - | - |\n'
    const once = canonicalizeMarkdown(src)
    expect(canonicalizeMarkdown(once)).toBe(once)
  })

  it('returns the empty string for empty input', () => {
    expect(canonicalizeMarkdown('')).toBe('')
  })

  it('normalizes CRLF line endings', () => {
    expect(canonicalizeMarkdown('# Plan\r\n\r\n- a\r\n')).toBe('# Plan\n\n- a')
  })
})
