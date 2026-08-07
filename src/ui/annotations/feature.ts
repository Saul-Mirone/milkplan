import type { Editor } from '@milkdown/kit/core'
import { $prose } from '@milkdown/kit/utils'

import type { DeepReadonly } from '../../shared/readonly'
import { createAnnotationPlugin, type AnnotationPluginConfig } from './plugin'

export type AnnotationFeatureConfig = AnnotationPluginConfig

/**
 * Shaped like Crepe's DefineFeature<Config> (not exported from the package
 * root) so it can be registered with crepe.addFeature(...) before create().
 */
export function annotationFeature(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Editor is a mutable third-party class that annotationFeature registers a plugin onto via editor.use(); the signature must match Crepe's DefineFeature<Config> exactly.
  editor: Editor,
  config?: DeepReadonly<AnnotationFeatureConfig>,
): void {
  if (!config) return
  editor.use($prose(() => createAnnotationPlugin(config)))
}
