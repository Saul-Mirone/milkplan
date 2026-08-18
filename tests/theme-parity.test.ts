import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const STYLE = new URL('../src/ui/style.css', import.meta.url)

/** `--crepe-color-*: <value>;` pairs, in declaration order. */
async function crepeColors(specifier: string): Promise<Map<string, string>> {
  const css = await readFile(new URL(import.meta.resolve(specifier)), 'utf8')
  const colors = new Map<string, string>()
  for (const match of css.matchAll(/(--crepe-color-[\w-]+):\s*([^;]+);/gu))
    colors.set(match[1] ?? '', (match[2] ?? '').trim())
  return colors
}

/**
 * Crepe ships its light and dark palettes as two stylesheets and offers no
 * other switch, so style.css used to pull the dark one in behind a
 * `(prefers-color-scheme: dark)` @import — which the theme toggle cannot
 * override. Both palettes are vendored into light-dark() declarations instead,
 * and this is what keeps that copy honest: a crepe upgrade that restyles nord
 * fails here rather than leaving the review page half on the old palette.
 */
describe('the vendored Crepe palette', () => {
  it('reproduces every upstream nord / nord-dark pair as a light-dark()', async () => {
    const [light, dark, css] = await Promise.all([
      crepeColors('@milkdown/crepe/theme/nord.css'),
      crepeColors('@milkdown/crepe/theme/nord-dark.css'),
      readFile(STYLE, 'utf8'),
    ])

    expect(light.size).toBeGreaterThan(0)
    expect([...dark.keys()]).toEqual([...light.keys()])
    for (const [name, lightValue] of light)
      expect(css).toContain(
        `${name}: light-dark(${lightValue}, ${dark.get(name)});`,
      )
  })

  it('no longer routes anything through prefers-color-scheme', async () => {
    // A media query answers only to the OS, so any rule left behind one is a
    // rule the toggle cannot move — and it would win over the light-dark()
    // declarations whenever the OS disagreed with the reviewer's choice.
    // Anchored on the at-rules so the prose in the comments stays free.
    const css = await readFile(STYLE, 'utf8')
    expect(css).not.toMatch(/@(?:import|media)[^;{]*prefers-color-scheme/u)
    expect(css).not.toMatch(/@import[^;]*nord-dark/u)
  })

  it('keeps the color-scheme declaration every light-dark() resolves against', async () => {
    const css = await readFile(STYLE, 'utf8')
    expect(css).toContain('color-scheme: light dark;')
  })
})
