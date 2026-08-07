import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from '@milkdown/kit/prose/state'
import {
  Decoration,
  DecorationSet,
  type EditorView,
} from '@milkdown/kit/prose/view'
import type { Node } from '@milkdown/kit/prose/model'

import type { DeepReadonly } from '../../shared/readonly'

export interface AnnotationRecord {
  id: string
  from: number
  to: number
  comment: string
  createdExcerpt: string
  orphaned: boolean
  /**
   * True from `begin` until `commit`: the comment popover is still open. A
   * pending record lives in plugin state so its range is remapped through
   * every transaction while the user types — Save can never anchor to stale
   * positions. Pending records are excluded from sidebar and serialization.
   */
  pending: boolean
}

export interface AnnotationState {
  annotations: AnnotationRecord[]
  decorations: DecorationSet
  activeId: string | null
}

export type AnnotationAction =
  | {
      type: 'begin'
      id: string
      from: number
      to: number
      createdExcerpt: string
    }
  | { type: 'commit'; id: string; comment: string }
  | { type: 'remove'; id: string }
  | { type: 'setActive'; id: string | null }

export interface AnnotationPluginConfig {
  onChange: (state: DeepReadonly<AnnotationState>) => void
}

export const annotationPluginKey = new PluginKey<AnnotationState>(
  'MILKPLAN_ANNOTATION',
)

export const emptyAnnotationState: AnnotationState = {
  annotations: [],
  decorations: DecorationSet.empty,
  activeId: null,
}

function buildDecorations(
  // ProseMirror `DecorationSet.create` requires the mutable `Node` type.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  doc: Transaction['doc'],
  annotations: DeepReadonly<AnnotationRecord[]>,
  activeId: string | null,
): DecorationSet {
  const decorations = annotations
    .filter((record) => !record.orphaned)
    .map((record) => {
      const classes = ['mp-annotation']
      if (record.id === activeId) classes.push('mp-annotation--active')
      if (record.pending) classes.push('mp-annotation--pending')
      return Decoration.inline(record.from, record.to, {
        class: classes.join(' '),
        'data-annotation-id': record.id,
      })
    })
  return DecorationSet.create(doc, decorations)
}

function remapThrough(
  // Read-only use of `tr.mapping`, but a deep-readonly ProseMirror
  // Transaction cannot be resolved cleanly.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  tr: Transaction,
  annotations: DeepReadonly<AnnotationRecord[]>,
): AnnotationRecord[] {
  return annotations.map((record) => {
    if (record.orphaned) return record
    const from = tr.mapping.map(record.from, 1)
    const to = tr.mapping.map(record.to, -1)
    // The anchor text was fully deleted: keep the record so createdExcerpt
    // still serializes, but stop decorating it.
    if (from >= to) return { ...record, from, to, orphaned: true }
    if (from === record.from && to === record.to) return record
    return { ...record, from, to }
  })
}

function reduceAction(
  state: DeepReadonly<Pick<AnnotationState, 'annotations' | 'activeId'>>,
  action: DeepReadonly<AnnotationAction>,
): Pick<AnnotationState, 'annotations' | 'activeId'> {
  switch (action.type) {
    case 'begin':
      return {
        annotations: [
          ...state.annotations,
          {
            id: action.id,
            from: action.from,
            to: action.to,
            comment: '',
            createdExcerpt: action.createdExcerpt,
            orphaned: action.from >= action.to,
            pending: true,
          },
        ],
        activeId: action.id,
      }
    case 'commit':
      return {
        annotations: state.annotations.map((record) =>
          record.id === action.id
            ? { ...record, comment: action.comment, pending: false }
            : record,
        ),
        activeId: state.activeId,
      }
    case 'remove':
      return {
        annotations: state.annotations.filter(
          (record) => record.id !== action.id,
        ),
        activeId: state.activeId === action.id ? null : state.activeId,
      }
    case 'setActive':
      return { annotations: [...state.annotations], activeId: action.id }
    default:
      return action
  }
}

function applyAnnotationState(
  // `tr` is a ProseMirror Transaction read here but not deep-readonly-resolvable.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  tr: Transaction,
  // `prev` is returned by reference on the no-op fast path to preserve the
  // plugin state's referential identity, so it cannot be a readonly type.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  prev: AnnotationState,
): AnnotationState {
  // `getMeta` returns `any`; the meta stored under this key is always our action.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const action = tr.getMeta(annotationPluginKey) as AnnotationAction | undefined
  if (!action && !tr.docChanged) return prev

  let next: Pick<AnnotationState, 'annotations' | 'activeId'> = {
    annotations: remapThrough(tr, prev.annotations),
    activeId: prev.activeId,
  }
  if (action) next = reduceAction(next, action)

  return {
    annotations: next.annotations,
    activeId: next.activeId,
    decorations: buildDecorations(tr.doc, next.annotations, next.activeId),
  }
}

function annotationDecorations(
  // ProseMirror `PluginKey.getState` requires the mutable `EditorState` type.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  state: EditorState,
): DecorationSet | undefined {
  return annotationPluginKey.getState(state)?.decorations
}

function handleAnnotationClick(
  // ProseMirror handler params (EditorView / Node / MouseEvent) cannot be
  // resolved to deep-readonly types cleanly; `view` is used to dispatch.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  view: EditorView,
  _pos: number,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  _node: Node,
  _nodePos: number,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  event: MouseEvent,
): boolean {
  const target = event.target
  if (!(target instanceof Element)) return false
  const marker = target.closest('[data-annotation-id]')
  const id = marker?.getAttribute('data-annotation-id')
  if (id === null || id === undefined || id === '') return false
  const action: AnnotationAction = { type: 'setActive', id }
  view.dispatch(view.state.tr.setMeta(annotationPluginKey, action))
  return false
}

export function createAnnotationPlugin(
  config: DeepReadonly<AnnotationPluginConfig>,
): Plugin<AnnotationState> {
  return new Plugin<AnnotationState>({
    key: annotationPluginKey,
    state: {
      init: () => emptyAnnotationState,
      apply: applyAnnotationState,
    },
    props: {
      decorations: annotationDecorations,
      handleClickOn: handleAnnotationClick,
    },
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
    view: (editorView) => {
      const initial = annotationPluginKey.getState(editorView.state)
      if (initial) config.onChange(initial)
      return {
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
        update: (view) => {
          const pluginState = annotationPluginKey.getState(view.state)
          if (pluginState) config.onChange(pluginState)
        },
      }
    },
  })
}
