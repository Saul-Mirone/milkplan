import { Crepe } from '@milkdown/crepe'
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core'
import {
  diffPluginKey,
  isChangeRejected,
  startDiffReviewCmd,
  type DiffState,
} from '@milkdown/kit/plugin/diff'
import { useEffect, useRef, useState } from 'react'

import { normalizeMarkdown } from '../../shared/markdown'
import type { DeepReadonly } from '../../shared/readonly'
import { diffFeature } from '../diff/feature'
import { highlightFeature, loadHighlighter } from '../highlight/feature'

type PaneStatus = 'loading' | 'diff' | 'no-changes' | 'error'

const PANE_NOTICES: Readonly<Record<Exclude<PaneStatus, 'diff'>, string>> = {
  loading: 'Computing changes…',
  'no-changes': 'No changes between these rounds.',
  error: 'Could not compute the diff.',
}

/** The slice of the diff plugin state the status derivation reads — newDoc
 *  stays out so tests can fabricate states without a ProseMirror document. */
export type DiffStateSlice = Pick<DiffState, 'changes' | 'rejectedRanges'>

/**
 * Pure status mapping, exported for the DOM tests: `started === false` means
 * the current markdown failed to parse — an error, never a no-change. And
 * identical documents leave the review active with zero pending changes (the
 * plugin does not deactivate itself); the string pre-check catches the
 * normalized-equal case, this predicate the semantic remainder.
 */
export function derivePaneStatus(
  started: boolean,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- DiffState slices carry live prosemirror-changeset objects; only read here.
  state: DiffStateSlice | null | undefined,
): Exclude<PaneStatus, 'loading'> {
  if (!started) return 'error'
  const pending =
    state === null || state === undefined
      ? []
      : state.changes.filter(
          (change: DeepReadonly<{ fromB: number; toB: number }>) =>
            !isChangeRejected(change, state.rejectedRanges),
        )
  return pending.length > 0 ? 'diff' : 'no-changes'
}

interface DiffPaneBootstrap {
  readonly root: HTMLElement
  readonly oldMarkdown: string
  readonly currentMarkdown: string
  readonly isCancelled: () => boolean
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- receives the mutable Crepe instance for teardown.
  readonly onCreated: (instance: Crepe) => void
  readonly onStatus: (status: Exclude<PaneStatus, 'loading'>) => void
}

/** Builds the second, read-only Crepe instance and starts the diff review.
 *  Deliberately independent of PlanEditor's bootstrapEditor — that one
 *  overwrites window.milkplanView, which must stay on the main editor. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- carries the live DOM mount node and the mutable Crepe handoff, matching PlanEditor's bootstrap.
async function bootstrapDiffPane(opts: DiffPaneBootstrap): Promise<void> {
  // Same cached shiki singleton as the main editor — no second load.
  const highlighter = await loadHighlighter()
  if (opts.isCancelled()) return
  const instance = new Crepe({
    root: opts.root,
    defaultValue: opts.oldMarkdown,
    features: {
      [Crepe.Feature.ImageBlock]: false,
      [Crepe.Feature.Latex]: false,
      [Crepe.Feature.CodeMirror]: false,
      [Crepe.Feature.Toolbar]: false,
      [Crepe.Feature.BlockEdit]: false,
      [Crepe.Feature.Placeholder]: false,
      [Crepe.Feature.Cursor]: false,
    },
  })
  opts.onCreated(instance)
  // Must happen before create(): $prose plugins register at editor setup.
  instance.addFeature(highlightFeature, { highlighter })
  instance.addFeature(diffFeature)
  instance.setReadonly(true)
  await instance.create()
  if (opts.isCancelled()) return
  const started = instance.editor.action(
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Milkdown Ctx is a mutable framework container.
    (ctx) =>
      ctx.get(commandsCtx).call(startDiffReviewCmd.key, opts.currentMarkdown),
  )
  const view = instance.editor.ctx.get(editorViewCtx)
  opts.onStatus(derivePaneStatus(started, diffPluginKey.getState(view.state)))
}

/** Owns the diff editor lifecycle for one picked round, mirroring
 *  PlanEditor's cancellable bootstrap (useCrepeEditor). */
function useDiffPane(oldMarkdown: string, currentMarkdown: string) {
  const rootRef = useRef<HTMLDivElement>(null)
  // Pre-check: normalized-equal rounds skip the whole Crepe bootstrap — a
  // zero-change diff review would just lock an empty editor.
  const unchanged =
    normalizeMarkdown(oldMarkdown) === normalizeMarkdown(currentMarkdown)
  const [status, setStatus] = useState<PaneStatus>(
    unchanged ? 'no-changes' : 'loading',
  )

  useEffect(() => {
    if (unchanged) return undefined
    const root = rootRef.current
    if (!root) return undefined

    let cancelled = false
    let crepe: Crepe | null = null
    const created = bootstrapDiffPane({
      root,
      oldMarkdown,
      currentMarkdown,
      isCancelled: () => cancelled,
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- captures the freshly built mutable Crepe instance for teardown.
      onCreated: (instance) => {
        crepe = instance
      },
      onStatus: (next) => {
        if (!cancelled) setStatus(next)
      },
    })
    void created.catch(() => {
      if (!cancelled) setStatus('error')
    })

    return () => {
      cancelled = true
      void created
        .catch(() => undefined)
        .then(() => crepe?.destroy())
        .catch(() => undefined)
    }
  }, [oldMarkdown, currentMarkdown, unchanged])

  return { rootRef, status }
}

/** One picked round diffed against the current submission. Never rendered by
 *  the DOM tests — a real Crepe does not survive happy-dom. Coverage instead:
 *  derivePaneStatus is unit-tested, the controls-hiding CSS has a dist canary,
 *  and the rendered diff is verified manually via `pnpm dev`'s fixture
 *  history. */
export function DiffEditorPane({
  oldMarkdown,
  currentMarkdown,
}: Readonly<{ oldMarkdown: string; currentMarkdown: string }>) {
  const { rootRef, status } = useDiffPane(oldMarkdown, currentMarkdown)
  return (
    <>
      {status !== 'diff' && (
        <p className="mp-diff-overlay__notice">{PANE_NOTICES[status]}</p>
      )}
      <div className="mp-editor" ref={rootRef} hidden={status !== 'diff'} />
    </>
  )
}
