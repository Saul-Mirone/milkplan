import {
  diffComponent,
  diffComponentConfig,
  type DiffComponentConfig,
} from '@milkdown/kit/component/diff'
import type { Editor } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { diff, diffConfig, type DiffConfig } from '@milkdown/kit/plugin/diff'
import {
  trailingConfig,
  type TrailingConfigOptions,
} from '@milkdown/kit/plugin/trailing'

import { listIgnoreAttrs, mergeIgnoreAttrs } from './ignore-attrs'
import type { DeepReadonly } from '../../shared/readonly'

/**
 * Registers Milkdown's diff stack on a Crepe instance: the diff plugin (state
 * + commands) and the diff component (decoration rendering). Must be added
 * before create() — the plugin's $prose rules register at editor setup.
 */
export function diffFeature(editor: DeepReadonly<Editor>): void {
  editor
    .config((ctx: DeepReadonly<Ctx>) => {
      // Crepe replaces these nodes with custom node views; the component only
      // routes its decorations through such views when they are listed here.
      ctx.update(
        diffComponentConfig.key,
        (prev: DeepReadonly<DiffComponentConfig>) => ({
          ...prev,
          customBlockTypes: ['table', 'image-block', 'code_block'],
        }),
      )
      // Merged, never replaced, so the shipped defaults (Crepe's volatile
      // heading ids today) survive alongside our formatting-only list attrs.
      // Marks are out of reach: the diff encoder consults ignoreAttrs for
      // nodes only, so emphasis marker style is handled upstream instead, by
      // canonicalizing the markdown on both sides (src/cli/canonical.ts).
      ctx.update(diffConfig.key, (prev: DeepReadonly<DiffConfig>) => ({
        ...prev,
        ignoreAttrs: mergeIgnoreAttrs(prev.ignoreAttrs, listIgnoreAttrs()),
      }))
      // Crepe always loads the trailing plugin, which appends an empty
      // paragraph to this (old-side) doc whenever the plan ends in a list,
      // code fence, or table. The new side is a bare parser() doc that never
      // gets one, so without this every such plan reports a phantom change at
      // the end. The pane is read-only; trailing has nothing to serve here.
      ctx.update(
        trailingConfig.key,
        (prev: DeepReadonly<TrailingConfigOptions>) => ({
          ...prev,
          shouldAppend: () => false,
        }),
      )
    })
    .use(diff)
    .use(diffComponent)
}
