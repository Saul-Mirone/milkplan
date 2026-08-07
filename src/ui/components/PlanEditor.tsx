/// <reference types="vite/client" />
import { Crepe } from '@milkdown/crepe'
import { editorViewCtx } from '@milkdown/kit/core'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import {
  useEffect,
  useImperativeHandle,
  useRef,
  type Ref,
  type RefObject,
} from 'react'

import type { DeepReadonly } from '../../shared/readonly'
import { annotationFeature } from '../annotations/feature'
import type { AnnotationState } from '../annotations/plugin'
import { highlightFeature, loadHighlighter } from '../highlight/feature'

const annotateIcon = `
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
  >
    <path
      d="M20 2H4C2.9 2 2.01 2.9 2.01 4L2 22L6 18H20C21.1 18 22 17.1 22 16V4C22 2.9 21.1 2 20 2ZM17 12H7C6.45 12 6 11.55 6 11C6 10.45 6.45 10 7 10H17C17.55 10 18 10.45 18 11C18 11.55 17.55 12 17 12ZM17 8.5H7C6.45 8.5 6 8.05 6 7.5C6 6.95 6.45 6.5 7 6.5H17C17.55 6.5 18 6.95 18 7.5C18 8.05 17.55 8.5 17 8.5Z"
    />
  </svg>
`

type AnnotateRange = { readonly from: number; readonly to: number }
type AnnotationsChange = (state: DeepReadonly<AnnotationState>) => void

export interface PlanEditorHandle {
  getMarkdown: () => string
  /** Compared against the post-parse baseline, never the original file. */
  isEdited: () => boolean
  getView: () => EditorView | null
}

interface PlanEditorProps {
  readonly defaultValue: string
  readonly onAnnotationsChange: AnnotationsChange
  readonly onAnnotate: (range: AnnotateRange) => void
  readonly ref: Ref<PlanEditorHandle>
}

type EditorCallbacks = Pick<
  PlanEditorProps,
  'defaultValue' | 'onAnnotationsChange' | 'onAnnotate'
>

/** Builds the (not-yet-created) Crepe instance, including the annotate toolbar. */
function createCrepe(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- live DOM mount node handed to Crepe.
  root: HTMLElement,
  defaultValue: string,
  getOnAnnotate: () => (range: AnnotateRange) => void,
): Crepe {
  return new Crepe({
    root,
    defaultValue,
    features: {
      [Crepe.Feature.ImageBlock]: false,
      [Crepe.Feature.Latex]: false,
      [Crepe.Feature.CodeMirror]: false,
    },
    featureConfigs: {
      [Crepe.Feature.Toolbar]: {
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Crepe's mutable toolbar builder.
        buildToolbar: (builder) => {
          builder.addGroup('annotate', 'Annotate').addItem('annotate', {
            icon: annotateIcon,
            active: () => false,
            // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Milkdown Ctx is a mutable framework container.
            onRun: (ctx) => {
              const view = ctx.get(editorViewCtx)
              const { selection } = view.state
              if (!(selection instanceof TextSelection) || selection.empty)
                return
              getOnAnnotate()({ from: selection.from, to: selection.to })
            },
          })
        },
      },
    },
  })
}

interface EditorBootstrap {
  readonly root: HTMLElement
  readonly defaultValue: string
  readonly isCancelled: () => boolean
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- receives the mutable Crepe instance for teardown.
  readonly onCreated: (instance: Crepe) => void
  readonly onAnnotateRef: RefObject<(range: AnnotateRange) => void>
  readonly onAnnotationsChangeRef: RefObject<AnnotationsChange>
  readonly baselineRef: RefObject<string | null>
  readonly crepeRef: RefObject<Crepe | null>
}

/**
 * Asynchronously builds the Crepe editor (shiki must load first), registers the
 * annotation + highlight features before create(), and records the post-parse
 * baseline. Bails at each cancellation checkpoint; the caller destroys whatever
 * was created via the instance handed to `onCreated`.
 */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- carries mutable React refs; the setup writes baselineRef/crepeRef.current, which a deep-readonly type would forbid.
async function bootstrapEditor(opts: EditorBootstrap): Promise<void> {
  const highlighter = await loadHighlighter()
  if (opts.isCancelled()) return
  const instance = createCrepe(
    opts.root,
    opts.defaultValue,
    () => opts.onAnnotateRef.current,
  )
  opts.onCreated(instance)
  // Must happen before create(): $prose plugins register at editor setup.
  instance.addFeature(annotationFeature, {
    onChange: (state) => {
      opts.onAnnotationsChangeRef.current(state)
    },
  })
  instance.addFeature(highlightFeature, { highlighter })

  await instance.create()
  if (opts.isCancelled()) return
  opts.baselineRef.current = instance.getMarkdown()
  opts.crepeRef.current = instance
  if (import.meta.env.DEV) {
    // Dev-only handle for E2E automation: synthetic DOM selections do not
    // survive Crepe's virtual-cursor sync, so tests drive PM directly.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- dev-only window debug handle; Window has no typed slot for it.
    ;(window as unknown as { milkplanView?: EditorView }).milkplanView =
      instance.editor.ctx.get(editorViewCtx)
  }
}

/**
 * Owns the Crepe lifecycle: builds the editor asynchronously, mirrors callbacks
 * through refs so the one-shot closures stay current, and tears everything down
 * on unmount.
 */
function useCrepeEditor(options: EditorCallbacks) {
  const { defaultValue, onAnnotate, onAnnotationsChange } = options
  const rootRef = useRef<HTMLDivElement>(null)
  const crepeRef = useRef<Crepe | null>(null)
  const baselineRef = useRef<string | null>(null)
  const onAnnotateRef = useRef(onAnnotate)
  onAnnotateRef.current = onAnnotate
  const onAnnotationsChangeRef = useRef(onAnnotationsChange)
  onAnnotationsChangeRef.current = onAnnotationsChange

  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined

    let cancelled = false
    let crepe: Crepe | null = null
    const created = bootstrapEditor({
      root,
      defaultValue,
      isCancelled: () => cancelled,
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- captures the freshly built mutable Crepe instance for teardown.
      onCreated: (instance) => {
        crepe = instance
      },
      onAnnotateRef,
      onAnnotationsChangeRef,
      baselineRef,
      crepeRef,
    })

    return () => {
      cancelled = true
      crepeRef.current = null
      baselineRef.current = null
      void created
        .catch(() => undefined)
        .then(() => crepe?.destroy())
        .catch(() => undefined)
    }
  }, [defaultValue])

  return { rootRef, crepeRef, baselineRef }
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- `ref` (React Ref) is structurally mutable and forwarded to useImperativeHandle.
export function PlanEditor({
  defaultValue,
  onAnnotationsChange,
  onAnnotate,
  ref,
}: PlanEditorProps) {
  const { rootRef, crepeRef, baselineRef } = useCrepeEditor({
    defaultValue,
    onAnnotationsChange,
    onAnnotate,
  })

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => crepeRef.current?.getMarkdown() ?? defaultValue,
      isEdited: () => {
        const crepe = crepeRef.current
        const baseline = baselineRef.current
        if (!crepe || baseline === null) return false
        return crepe.getMarkdown() !== baseline
      },
      getView: () => {
        const crepe = crepeRef.current
        if (!crepe) return null
        try {
          return crepe.editor.ctx.get(editorViewCtx)
        } catch {
          return null
        }
      },
    }),
    [defaultValue, crepeRef, baselineRef],
  )

  return <div className="mp-editor" ref={rootRef} />
}
