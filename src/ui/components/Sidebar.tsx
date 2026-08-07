import { useCallback } from 'react'
import type { ChangeEvent, KeyboardEvent, MouseEvent } from 'react'

import type { DeepReadonly } from '../../shared/readonly'
import type { AnnotationRecord } from '../annotations/plugin'

interface SidebarProps {
  annotations: readonly DeepReadonly<AnnotationRecord>[]
  activeId: string | null
  excerptFor: (record: DeepReadonly<AnnotationRecord>) => string
  onSelect: (record: DeepReadonly<AnnotationRecord>) => void
  onDelete: (id: string) => void
  overallFeedback: string
  onOverallFeedbackChange: (value: string) => void
}

interface AnnotationListProps {
  annotations: readonly DeepReadonly<AnnotationRecord>[]
  activeId: string | null
  excerptFor: (record: DeepReadonly<AnnotationRecord>) => string
  onSelect: (record: DeepReadonly<AnnotationRecord>) => void
  onDelete: (id: string) => void
}

interface AnnotationCardProps {
  record: DeepReadonly<AnnotationRecord>
  isActive: boolean
  excerpt: string
  onSelect: (record: DeepReadonly<AnnotationRecord>) => void
  onDelete: (id: string) => void
}

function cardClassName(isActive: boolean, orphaned: boolean): string {
  return [
    'mp-card',
    isActive ? 'mp-card--active' : '',
    orphaned ? 'mp-card--orphaned' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

function useCardHandlers(
  record: DeepReadonly<AnnotationRecord>,
  onSelect: (record: DeepReadonly<AnnotationRecord>) => void,
  onDelete: (id: string) => void,
) {
  const handleSelect = useCallback(() => {
    onSelect(record)
  }, [onSelect, record])
  const handleKeyDown = useCallback(
    // Synthetic DOM events are not deeply readonly; the body only reads them.
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Enter' || event.key === ' ') onSelect(record)
    },
    [onSelect, record],
  )
  const handleDelete = useCallback(
    // Synthetic DOM events are not deeply readonly; the body only reads them.
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      onDelete(record.id)
    },
    [onDelete, record.id],
  )
  return { handleSelect, handleKeyDown, handleDelete }
}

function AnnotationCard({
  record,
  isActive,
  excerpt,
  onSelect,
  onDelete,
}: Readonly<AnnotationCardProps>) {
  const { handleSelect, handleKeyDown, handleDelete } = useCardHandlers(
    record,
    onSelect,
    onDelete,
  )
  // The card is selectable via click/keydown but contains a nested Delete
  // <button>, so it cannot itself be a <button>; role="button" + tabIndex +
  // onKeyDown keep it keyboard-operable while preserving the original markup.
  // oxlint-disable jsx-a11y/prefer-tag-over-role
  const card = (
    <div
      className={cardClassName(isActive, record.orphaned)}
      role="button"
      tabIndex={0}
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
    >
      <blockquote className="mp-card__excerpt">{excerpt}</blockquote>
      <p className="mp-card__comment">{record.comment}</p>
      <div className="mp-card__footer">
        {record.orphaned && <span className="mp-badge">orphaned</span>}
        <button
          type="button"
          className="mp-card__delete"
          onClick={handleDelete}
        >
          Delete
        </button>
      </div>
    </div>
  )
  // oxlint-enable jsx-a11y/prefer-tag-over-role
  return card
}

function AnnotationList({
  annotations,
  activeId,
  excerptFor,
  onSelect,
  onDelete,
}: Readonly<AnnotationListProps>) {
  return (
    <section className="mp-sidebar__section">
      <h2 className="mp-sidebar__title">
        Annotations
        {annotations.length > 0 && (
          <span className="mp-sidebar__count">{annotations.length}</span>
        )}
      </h2>
      {annotations.length === 0 ? (
        <p className="mp-sidebar__empty">
          Select text in the plan and click the comment button in the toolbar to
          attach a note.
        </p>
      ) : (
        <ul className="mp-card-list">
          {annotations.map((record) => (
            <li key={record.id}>
              <AnnotationCard
                record={record}
                isActive={record.id === activeId}
                excerpt={excerptFor(record)}
                onSelect={onSelect}
                onDelete={onDelete}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function Sidebar({
  annotations,
  activeId,
  excerptFor,
  onSelect,
  onDelete,
  overallFeedback,
  onOverallFeedbackChange,
}: Readonly<SidebarProps>) {
  const handleFeedbackChange = useCallback(
    // Synthetic change events are not deeply readonly; body only reads them.
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      onOverallFeedbackChange(event.target.value)
    },
    [onOverallFeedbackChange],
  )
  return (
    <aside className="mp-sidebar">
      <AnnotationList
        annotations={annotations}
        activeId={activeId}
        excerptFor={excerptFor}
        onSelect={onSelect}
        onDelete={onDelete}
      />
      <section className="mp-sidebar__section">
        <h2 className="mp-sidebar__title">Overall feedback</h2>
        <textarea
          className="mp-sidebar__feedback"
          placeholder="Notes that apply to the plan as a whole…"
          rows={5}
          value={overallFeedback}
          onChange={handleFeedbackChange}
        />
      </section>
    </aside>
  )
}
