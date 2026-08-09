import { diffComponentConfig } from '@milkdown/kit/component/diff'
import type { Editor } from '@milkdown/kit/core'
import { diffConfig } from '@milkdown/kit/plugin/diff'
import { trailingConfig } from '@milkdown/kit/plugin/trailing'
import { describe, expect, it } from 'vitest'

import { diffFeature } from '../src/ui/diff/feature'
import { listIgnoreAttrs } from '../src/ui/diff/ignore-attrs'
import type { DeepReadonly } from '../src/shared/readonly'

/** The three slice shapes diffFeature touches, as this test seeds them. */
type Slice =
  | { ignoreAttrs: Record<string, string[]> }
  | { acceptLabel: string; rejectLabel: string; customBlockTypes: string[] }
  | { shouldAppend: () => boolean; getNode: () => null }

/**
 * diffFeature's whole job is three ctx.update calls, and each one silently
 * stops mattering if an upstream key moves. Running the real callbacks against
 * a Map-backed ctx checks the wiring without booting Crepe (which needs a DOM
 * and shiki). The seeded values mirror the shipped defaults, so a future
 * upstream change to those defaults surfaces here as a failure to re-read
 * rather than as a silently weaker diff.
 */
function runFeature() {
  const slices = new Map<unknown, Slice>([
    [diffConfig.key, { ignoreAttrs: { heading: ['id'] } }],
    [
      diffComponentConfig.key,
      { acceptLabel: 'Accept', rejectLabel: 'Reject', customBlockTypes: [] },
    ],
    [trailingConfig.key, { shouldAppend: () => true, getNode: () => null }],
  ])
  const ctx = {
    update(key: unknown, fn: (prev: DeepReadonly<Slice> | undefined) => Slice) {
      slices.set(key, fn(slices.get(key)))
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

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double implementing only the two Editor methods diffFeature calls.
  diffFeature(editor as unknown as Editor)
  for (const fn of configs) fn(ctx)

  // Narrowing lives here rather than in the tests: each `in` check doubles as
  // the assertion that the slice was updated at all.
  const diff = slices.get(diffConfig.key)
  if (diff === undefined || !('ignoreAttrs' in diff))
    throw new Error('diffConfig slice was never updated')
  const component = slices.get(diffComponentConfig.key)
  if (component === undefined || !('customBlockTypes' in component))
    throw new Error('diffComponentConfig slice was never updated')
  const trailing = slices.get(trailingConfig.key)
  if (trailing === undefined || !('shouldAppend' in trailing))
    throw new Error('trailingConfig slice was never updated')
  return { diff, component, trailing }
}

describe('diffFeature wiring', () => {
  it('merges the formatting-only list attrs into the shipped ignoreAttrs', () => {
    expect(runFeature().diff.ignoreAttrs).toEqual({
      heading: ['id'],
      ...listIgnoreAttrs(),
    })
  })

  it('still registers Crepe custom node views with the diff component', () => {
    const { component } = runFeature()
    expect(component.customBlockTypes).toEqual([
      'table',
      'image-block',
      'code_block',
    ])
    // Spread, not replaced: the labels the component renders must survive.
    expect(component.acceptLabel).toBe('Accept')
  })

  it('stops the trailing plugin appending to the old-side doc, keeping getNode', () => {
    const { trailing } = runFeature()
    expect(trailing.shouldAppend()).toBe(false)
    expect(trailing.getNode).toBeTypeOf('function')
  })
})
