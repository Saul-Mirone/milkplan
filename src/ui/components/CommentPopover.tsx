import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'

import type { DeepReadonly } from '../../shared/readonly'

const POPOVER_WIDTH = 320
/** Room left below the popover so its Save/Cancel row stays on screen. */
const POPOVER_HEIGHT = 180
const VIEWPORT_MARGIN = 8

export interface PopoverCoords {
  left: number
  bottom: number
}

export interface Viewport {
  width: number
  height: number
}

/**
 * Places the popover next to the annotated text, clamped into the viewport.
 *
 * This arithmetic is the only thing keeping the comment box reachable in the
 * cases it exists for: an annotation at the right edge (unclamped, the box
 * would hang off-screen with its buttons unreachable) and one near the bottom
 * of a long plan (it would open below the fold).
 *
 * The width is clamped as well as the offset. A viewport narrower than the
 * popover cannot be fixed by moving it: the dialog is position:fixed and its
 * actions row is right-aligned, so a fixed 320 would leave Save and Cancel
 * off-screen with no scrolling that reaches them.
 */
export function popoverStyle(
  coords: DeepReadonly<PopoverCoords>,
  viewport: DeepReadonly<Viewport>,
): CSSProperties {
  const width = Math.max(
    0,
    Math.min(POPOVER_WIDTH, viewport.width - 2 * VIEWPORT_MARGIN),
  )
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(coords.left, viewport.width - width - VIEWPORT_MARGIN),
  )
  const top = Math.min(
    coords.bottom + VIEWPORT_MARGIN,
    viewport.height - POPOVER_HEIGHT,
  )
  return { left, top, width }
}

/**
 * The slice of an EditorView this component reads. Narrowing to it keeps the
 * popover renderable without an editor instance — EditorView satisfies it
 * structurally, and coordsAtPos is genuinely all that is used.
 */
export interface CoordsSource {
  coordsAtPos: (pos: number) => PopoverCoords
}

interface CommentPopoverProps {
  getView: () => CoordsSource | null
  from: number
  onSave: (comment: string) => void
  onCancel: () => void
}

function useCommentDraft(
  onSave: (comment: string) => void,
  onCancel: () => void,
) {
  const [comment, setComment] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const save = useCallback(() => {
    const trimmed = comment.trim()
    if (trimmed.length > 0) onSave(trimmed)
  }, [comment, onSave])

  const handleChange = useCallback(
    (event: { readonly target: { readonly value: string } }) => {
      setComment(event.target.value)
    },
    [],
  )

  const handleKeyDown = useCallback(
    (event: {
      readonly key: string
      readonly metaKey: boolean
      readonly ctrlKey: boolean
    }) => {
      if (event.key === 'Escape') onCancel()
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save()
    },
    [onCancel, save],
  )

  return { comment, textareaRef, save, handleChange, handleKeyDown }
}

function PopoverActions({
  canSave,
  onCancel,
  onSave,
}: Readonly<{
  canSave: boolean
  onCancel: () => void
  onSave: () => void
}>) {
  return (
    <div className="mp-popover__actions">
      <button
        type="button"
        className="mp-button mp-button--ghost"
        onClick={onCancel}
      >
        Cancel
      </button>
      <button
        type="button"
        className="mp-button mp-button--primary"
        disabled={!canSave}
        onClick={onSave}
      >
        Save
      </button>
    </div>
  )
}

export function CommentPopover({
  getView,
  from,
  onSave,
  onCancel,
}: Readonly<CommentPopoverProps>) {
  const { comment, textareaRef, save, handleChange, handleKeyDown } =
    useCommentDraft(onSave, onCancel)

  const view = getView()

  const style = useMemo<CSSProperties>(() => {
    if (view === null) return { width: POPOVER_WIDTH }
    return popoverStyle(view.coordsAtPos(from), {
      width: window.innerWidth,
      height: window.innerHeight,
    })
  }, [view, from])

  if (view === null) return null

  const canSave = comment.trim().length > 0

  return (
    <dialog
      open
      className="mp-popover"
      style={style}
      aria-label="Add annotation"
    >
      <textarea
        ref={textareaRef}
        className="mp-popover__textarea"
        placeholder="Comment on the selected text…"
        rows={4}
        value={comment}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      <PopoverActions canSave={canSave} onCancel={onCancel} onSave={save} />
    </dialog>
  )
}
