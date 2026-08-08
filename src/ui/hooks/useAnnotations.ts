import type { Node } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { useCallback, useMemo, useSyncExternalStore } from 'react'

import type { DeepReadonly } from '../../shared/readonly'
import {
  annotationPluginKey,
  emptyAnnotationState,
  type AnnotationAction,
  type AnnotationRecord,
  type AnnotationState,
} from '../annotations/plugin'

/** External store fed by the annotation plugin's onChange callback. */
export interface AnnotationStore {
  onChange: (state: DeepReadonly<AnnotationState>) => void
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => DeepReadonly<AnnotationState>
}

export function createAnnotationStore(): AnnotationStore {
  let snapshot: DeepReadonly<AnnotationState> = emptyAnnotationState
  const listeners = new Set<() => void>()
  return {
    onChange: (state) => {
      snapshot = state
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
  }
}

export type ViewGetter = () => EditorView | null

/**
 * The slice of an EditorView these two helpers read. Narrowing to it is what
 * lets them be exercised against a bare ProseMirror document, with no DOM and
 * no editor instance — EditorView satisfies it structurally.
 */
export interface DocSource {
  state: { doc: Node }
}

/**
 * Builds the `begin` action for a selection, or null when the range cannot
 * carry an annotation.
 *
 * The guards are what stop an empty selection or a stale range (a toolbar
 * click racing an edit that shortened the document) from creating a record
 * that is orphaned the moment it exists. `id` is injected rather than
 * generated here so the action is a pure function of its inputs.
 */
export function beginActionFor(
  // ProseMirror's Node is a mutable class; only reads happen here.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  view: DocSource | null,
  from: number,
  to: number,
  id: string,
): AnnotationAction | null {
  if (!view || from >= to || to > view.state.doc.content.size) return null
  return {
    type: 'begin',
    id,
    from,
    to,
    createdExcerpt: view.state.doc.textBetween(from, to),
  }
}

/**
 * The text a record should quote: live document text while the anchor still
 * exists, the text captured at creation once it has been deleted.
 *
 * The try/catch only matters if a stale record is read across an editor
 * rebuild — plugin-remapped positions are valid by construction.
 */
export function excerptOf(
  // ProseMirror's Node is a mutable class; only reads happen here.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  view: DocSource | null,
  record: DeepReadonly<AnnotationRecord>,
): string {
  if (record.orphaned || !view) return record.createdExcerpt
  try {
    return view.state.doc.textBetween(record.from, record.to)
  } catch {
    return record.createdExcerpt
  }
}

export interface UseAnnotationsResult {
  /** Committed annotations only — what the sidebar shows and decisions send. */
  annotations: AnnotationRecord[]
  /** The record whose comment popover is open, live-remapped through edits. */
  pendingAnnotation: AnnotationRecord | null
  activeId: string | null
  /** Starts a pending annotation for the range; returns its id, or null. */
  beginAnnotation: (from: number, to: number) => string | null
  commitAnnotation: (id: string, comment: string) => void
  removeAnnotation: (id: string) => void
  setActive: (id: string | null) => void
  excerptFor: (record: DeepReadonly<AnnotationRecord>) => string
}

type AnnotationDispatch = (action: DeepReadonly<AnnotationAction>) => void

/** Sends an annotation action through the active editor view, if any. */
function useAnnotationDispatch(getView: ViewGetter): AnnotationDispatch {
  return useCallback(
    (action: DeepReadonly<AnnotationAction>) => {
      const view = getView()
      if (!view) return
      view.dispatch(view.state.tr.setMeta(annotationPluginKey, action))
    },
    [getView],
  )
}

/** The imperative annotation mutators exposed by {@link useAnnotations}. */
function useAnnotationActions(
  dispatch: AnnotationDispatch,
  getView: ViewGetter,
) {
  const beginAnnotation = useCallback(
    (from: number, to: number) => {
      const action = beginActionFor(getView(), from, to, crypto.randomUUID())
      if (action === null) return null
      dispatch(action)
      return action.id
    },
    [dispatch, getView],
  )

  const commitAnnotation = useCallback(
    (id: string, comment: string) => {
      dispatch({ type: 'commit', id, comment })
    },
    [dispatch],
  )

  const removeAnnotation = useCallback(
    (id: string) => {
      dispatch({ type: 'remove', id })
    },
    [dispatch],
  )

  const setActive = useCallback(
    (id: string | null) => {
      dispatch({ type: 'setActive', id })
    },
    [dispatch],
  )

  return { beginAnnotation, commitAnnotation, removeAnnotation, setActive }
}

/** Reads the live excerpt for a record, falling back to its created text. */
function useExcerptFor(
  getView: ViewGetter,
): (record: DeepReadonly<AnnotationRecord>) => string {
  return useCallback(
    (record: DeepReadonly<AnnotationRecord>) => excerptOf(getView(), record),
    [getView],
  )
}

export function useAnnotations(
  store: DeepReadonly<AnnotationStore>,
  getView: ViewGetter,
): UseAnnotationsResult {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)

  const dispatch = useAnnotationDispatch(getView)
  const { beginAnnotation, commitAnnotation, removeAnnotation, setActive } =
    useAnnotationActions(dispatch, getView)
  const excerptFor = useExcerptFor(getView)

  const annotations = useMemo(
    () => state.annotations.filter((record) => !record.pending),
    [state.annotations],
  )
  const pendingAnnotation = useMemo(
    () => state.annotations.find((record) => record.pending) ?? null,
    [state.annotations],
  )

  return {
    annotations,
    pendingAnnotation,
    activeId: state.activeId,
    beginAnnotation,
    commitAnnotation,
    removeAnnotation,
    setActive,
    excerptFor,
  }
}
