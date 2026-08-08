import {
  diffComponent,
  diffComponentConfig,
  type DiffComponentConfig,
} from '@milkdown/kit/component/diff'
import type { Editor } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { diff } from '@milkdown/kit/plugin/diff'

import type { DeepReadonly } from '../../shared/readonly'

/**
 * Registers Milkdown's diff stack on a Crepe instance: the diff plugin (state
 * + commands) and the diff component (decoration rendering). Must be added
 * before create() — the plugin's $prose rules register at editor setup.
 *
 * diffConfig is left at its shipped default, which already ignores Crepe's
 * volatile heading ids (`ignoreAttrs: {heading: ['id']}`) — restating it here
 * would clobber whatever defaults a future plugin version adds.
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
    })
    .use(diff)
    .use(diffComponent)
}
