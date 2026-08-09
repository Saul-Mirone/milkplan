import type { DiffIgnoreAttrs } from '@milkdown/kit/plugin/diff'

import type { DeepReadonly } from '../../shared/readonly'

/**
 * List attrs that encode presentation rather than content, and so must not
 * count towards node identity in the diff:
 *
 * - `list_item.label` holds the rendered ordinal ("1.", "2.", …) that
 *   remark-add-order-in-list-plugin writes at parse time. Inserting one step
 *   re-labels every later item, and since the diff matches block children by a
 *   signature built from their attrs, all of them stop matching and repaint —
 *   the single biggest source of spurious diffs between plan rounds.
 * - `list_item.listType` is redundant with the parent node type: a bullet list
 *   and an ordered list are different node types, whose names lead every
 *   signature, so list kind is still compared.
 * - `spread` (on items and on both list types) is tight/loose formatting; a
 *   blank-line reformat is not a content change.
 *
 * Deliberately left as identity: `ordered_list.order` (a changed start number
 * is semantic) and the GFM `list_item.checked` attr (a checkbox toggle is a
 * real change).
 */
export function listIgnoreAttrs(): DiffIgnoreAttrs {
  return {
    list_item: ['label', 'listType', 'spread'],
    bullet_list: ['spread'],
    ordered_list: ['spread'],
  }
}

/**
 * Unions the ignore lists per node type so the shipped defaults survive —
 * `{heading: ['id']}` today, whatever a future plugin version adds tomorrow.
 * Rebuilds every array because the caller's config arrives deep-readonly.
 */
export function mergeIgnoreAttrs(
  prev: DeepReadonly<DiffIgnoreAttrs>,
  extra: DeepReadonly<DiffIgnoreAttrs>,
): DiffIgnoreAttrs {
  const merged: DiffIgnoreAttrs = {}
  for (const [type, keys] of Object.entries(prev)) merged[type] = [...keys]
  for (const [type, keys] of Object.entries(extra))
    merged[type] = [...new Set([...(merged[type] ?? []), ...keys])]
  return merged
}
