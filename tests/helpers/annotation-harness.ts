import { EditorState } from '@milkdown/kit/prose/state'
import { Schema } from '@milkdown/kit/prose/model'
import type { Node } from '@milkdown/kit/prose/model'
import type { Decoration } from '@milkdown/kit/prose/view'

import {
  annotationPluginKey,
  createAnnotationPlugin,
  type AnnotationAction,
  type AnnotationRecord,
} from '../../src/ui/annotations/plugin'
import type { DeepReadonly } from '../../src/shared/readonly'

/**
 * A three-node schema is enough: the plugin only ever touches positions and
 * `tr.mapping`, never node types. Building the state by hand keeps the
 * annotation suites in the default node environment — no DOM, no Crepe, no
 * shiki, no new dependency.
 */
const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0] },
    text: {},
  },
})

/**
 * Document layout, with every position the suites depend on:
 *
 *   0        <p> open
 *   1..10    "Intro line"
 *   11       </p> close
 *   12       <p> open
 *   13..31   "The quick brown fox"
 *   32       </p> close
 *
 * so "quick" occupies [17, 22) and "Intro" occupies [1, 6) in a genuinely
 * different block rather than a same-paragraph prefix.
 */
export const QUICK_FROM = 17
export const QUICK_TO = 22
export const INTRO_FROM = 1
export const INTRO_TO = 6

function makeDoc() {
  return schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('Intro line')]),
    schema.node('paragraph', null, [schema.text('The quick brown fox')]),
  ])
}

/**
 * The slice of an EditorView that beginActionFor/excerptOf read, backed by a
 * real ProseMirror document — no DOM, no editor instance.
 */
export function makeDocSource(): { state: { doc: Node } } {
  return { state: { doc: makeDoc() } }
}

export interface Harness {
  dispatch: (action: DeepReadonly<AnnotationAction>) => void
  insertText: (text: string, at: number) => void
  deleteRange: (from: number, to: number) => void
  /** A transaction with neither an action nor a doc change (a cursor move). */
  touch: () => void
  records: () => readonly DeepReadonly<AnnotationRecord>[]
  record: (id: string) => DeepReadonly<AnnotationRecord>
  textOf: (from: number, to: number) => string
  decorations: () => readonly Decoration[]
  /** Identity of the plugin state object, for referential-stability checks. */
  pluginStateRef: () => object
}

export function makeHarness(): Harness {
  let state = EditorState.create({
    schema,
    doc: makeDoc(),
    // onChange is driven by the plugin's `view`, which only an EditorView
    // creates; with a bare EditorState it is never called.
    plugins: [createAnnotationPlugin({ onChange: () => {} })],
  })

  const pluginState = () => {
    const value = annotationPluginKey.getState(state)
    if (value === undefined)
      throw new Error('annotation plugin state is missing')
    return value
  }

  return {
    dispatch(action) {
      state = state.apply(state.tr.setMeta(annotationPluginKey, action))
    },
    insertText(text, at) {
      state = state.apply(state.tr.insertText(text, at))
    },
    deleteRange(from, to) {
      state = state.apply(state.tr.delete(from, to))
    },
    touch() {
      state = state.apply(state.tr)
    },
    records: () => pluginState().annotations,
    record(id) {
      const found = pluginState().annotations.find(
        (candidate: DeepReadonly<AnnotationRecord>) => candidate.id === id,
      )
      if (found === undefined)
        throw new Error(`no annotation record with id ${id}`)
      return found
    },
    textOf: (from, to) => state.doc.textBetween(from, to),
    decorations: () => pluginState().decorations.find(),
    pluginStateRef: () => pluginState(),
  }
}

/** begin + commit, i.e. an annotation the user actually saved. */
export function annotate(
  harness: DeepReadonly<Harness>,
  id: string,
  from: number,
  to: number,
  comment: string,
): void {
  harness.dispatch({
    type: 'begin',
    id,
    from,
    to,
    createdExcerpt: harness.textOf(from, to),
  })
  harness.dispatch({ type: 'commit', id, comment })
}

export function boundsOf(
  record: DeepReadonly<AnnotationRecord>,
): [number, number] {
  return [record.from, record.to]
}
