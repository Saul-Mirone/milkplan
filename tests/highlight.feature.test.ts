import type { Editor } from '@milkdown/kit/core'
import { highlightPluginConfig } from '@milkdown/plugin-highlight'
import type { Parser } from '@milkdown/plugin-highlight/shiki'
import { beforeAll, describe, expect, it } from 'vitest'

import { highlightFeature, loadHighlighter } from '../src/ui/highlight/feature'

/** The one slice highlightFeature sets. */
type HighlightSlice = Readonly<{ parser: Parser }>

/** Decoration#type is opaque in prosemirror-view's types; the shiki parser
 *  writes the token style and class straight into its attrs. */
type TokenAttrs = Readonly<{ style?: string; class?: string }>
type StyledDecoration = Readonly<{ type: { attrs: TokenAttrs } }>

/** A `light-dark(<light>, <dark>)` color pair, as shiki writes it. */
const LIGHT_DARK = /light-dark\((#[0-9a-f]{3,8}),\s*(#[0-9a-f]{3,8})\)/iu

/**
 * Runs the real feature against a Map-backed ctx and a two-method editor
 * double — the same shape tests/diff.feature.test.ts uses — and hands back the
 * parser it registered. No DOM and no Crepe: since the feature stopped reading
 * `window.matchMedia` it is a pure function of its config, which is exactly
 * what this suite is here to keep true.
 */
async function buildParser(): Promise<Parser> {
  const highlighter = await loadHighlighter()
  const slices = new Map<unknown, HighlightSlice>()
  const ctx = {
    set(key: unknown, value: HighlightSlice) {
      slices.set(key, value)
    },
  }
  const configs: ((ctx: unknown) => void)[] = []
  const editor = {
    config(fn: (ctx: unknown) => void) {
      configs.push(fn)
      return editor
    },
    use() {
      return editor
    },
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double implementing only the two Editor methods highlightFeature calls.
  highlightFeature(editor as unknown as Editor, { highlighter })
  for (const fn of configs) fn(ctx)

  const config = slices.get(highlightPluginConfig.key)
  if (config === undefined)
    throw new Error('highlightPluginConfig was never set')
  return config.parser
}

function attrsOf(decoration: unknown): TokenAttrs {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- prosemirror-view types Decoration#type as opaque, so there is no checked path to the attrs the parser wrote.
  return (decoration as StyledDecoration).type.attrs
}

/** The `style` of every token decoration (the per-node one carries no class). */
function tokenStyles(decorations: readonly unknown[]): string[] {
  return decorations
    .filter((decoration) => attrsOf(decoration).class === 'shiki')
    .map((decoration) => attrsOf(decoration).style ?? '')
}

/** The (light, dark) halves of every token color that carries a pair. */
function colorPairs(
  styles: readonly string[],
): Readonly<{ light: string; dark: string }>[] {
  const pairs: Readonly<{ light: string; dark: string }>[] = []
  for (const style of styles) {
    const match = LIGHT_DARK.exec(style)
    if (match?.[1] !== undefined && match[2] !== undefined)
      pairs.push({ light: match[1], dark: match[2] })
  }
  return pairs
}

function run(parser: Parser, content: string, language: string) {
  return parser({ content, language, pos: 0, size: content.length + 2 })
}

/** `run` for the cases that expect a finished parse; a Promise there would
 *  mean a grammar is still loading and the assertions had nothing to read. */
function parse(
  parser: Parser,
  content: string,
  language: string,
): readonly unknown[] {
  const result = run(parser, content, language)
  if (result instanceof Promise) throw new Error('grammar still loading')
  return result
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('highlightFeature', () => {
  let parser: Parser
  beforeAll(async () => {
    parser = await buildParser()
  })

  it('gives every token both themes at once, so CSS alone can switch it', () => {
    // The bug this replaced: the theme was picked from matchMedia at editor
    // setup, baked into cached decorations, and could never move again —
    // prosemirror-highlight's cache is keyed by position and its plugin key is
    // module-private, so nothing outside can force a re-parse. Carrying both
    // colors means `color-scheme` on <html> decides at paint time instead.
    const styles = tokenStyles(parse(parser, 'const a = 1', 'typescript'))
    expect(styles.length).toBeGreaterThan(0)
    for (const style of styles) {
      expect(style).toMatch(LIGHT_DARK)
      expect(style).toContain('--shiki-light:')
      expect(style).toContain('--shiki-dark:')
    }
  })

  it('never bakes a single theme into a token color', () => {
    // `color:#24292e` — a bare hex outside light-dark() — is what the old
    // single-theme parser produced, and it is frozen on whatever the OS said
    // at load. Nothing may reintroduce it.
    for (const style of tokenStyles(parse(parser, 'const a = 1', 'typescript')))
      expect(style).not.toMatch(/color:\s*#/u)
  })

  it('really carries two different palettes, not one color written twice', () => {
    const pairs = colorPairs(
      tokenStyles(parse(parser, 'const a = 1', 'typescript')),
    )
    expect(pairs.length).toBeGreaterThan(0)
    expect(
      pairs.filter((pair) => pair.light !== pair.dark).length,
    ).toBeGreaterThan(0)
  })

  it('lazy-loads a bundled grammar that was not preloaded, then highlights it', async () => {
    // A Promise is the plugin's signal to refresh once the grammar lands;
    // returning [] here would freeze the block as plain text forever.
    const pending = run(parser, 'puts 1', 'ruby')
    expect(pending).toBeInstanceOf(Promise)
    await pending
    expect(tokenStyles(parse(parser, 'puts 1', 'ruby')).length).toBeGreaterThan(
      0,
    )
  })

  it('skips a fence whose language is unknown instead of killing the pass', () => {
    // prosemirror-highlight aborts the WHOLE decoration pass on the first
    // throw, so one junk fence would unstyle every code block after it.
    expect(run(parser, 'nothing', 'not-a-real-language')).toEqual([])
    expect(run(parser, 'nothing', '')).toEqual([])
  })
})
