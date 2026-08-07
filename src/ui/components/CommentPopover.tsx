import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'

import type { ViewGetter } from '../hooks/useAnnotations'

const POPOVER_WIDTH = 320

interface CommentPopoverProps {
  getView: ViewGetter
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
    const coords = view.coordsAtPos(from)
    const left = Math.max(
      8,
      Math.min(coords.left, window.innerWidth - POPOVER_WIDTH - 8),
    )
    const top = Math.min(coords.bottom + 8, window.innerHeight - 180)
    return { left, top, width: POPOVER_WIDTH }
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
