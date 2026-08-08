import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { PlanVersion } from '../../shared/protocol'
import type { DeepReadonly } from '../../shared/readonly'
import { versionLabel } from '../history'
import { DiffEditorPane } from './DiffEditorPane'

interface DiffOverlayProps {
  /** Earlier rounds, oldest first; never empty (App hides the entry then). */
  versions: readonly DeepReadonly<PlanVersion>[]
  /** The submitted plan of the current round — never the live edited doc. */
  currentMarkdown: string
  onClose: () => void
}

/** Read-only overlay diffing an earlier round against the current submission.
 *  Owns the picker state so every open starts back at the previous round. */
export function DiffOverlay({
  versions,
  currentMarkdown,
  onClose,
}: Readonly<DiffOverlayProps>) {
  const [selectedIndex, setSelectedIndex] = useState(versions.length - 1)
  const selected = versions[selectedIndex]
  return (
    <DiffOverlayView
      versions={versions}
      selectedIndex={selectedIndex}
      onSelect={setSelectedIndex}
      onClose={onClose}
    >
      {selected !== undefined && (
        // Keyed on the round: switching destroys and rebuilds the pane — one
        // bootstrap path, zero leftover diff state.
        <DiffEditorPane
          key={selectedIndex}
          oldMarkdown={selected.markdown}
          currentMarkdown={currentMarkdown}
        />
      )}
    </DiffOverlayView>
  )
}

/** Minimal readonly shape of the picker's change event (only value is read). */
type SelectChangeEvent = DeepReadonly<{ target: { value: string } }>

interface VersionPickerProps {
  versions: readonly DeepReadonly<PlanVersion>[]
  selectedIndex: number
  onSelect: (index: number) => void
}

function VersionPicker({
  versions,
  selectedIndex,
  onSelect,
}: Readonly<VersionPickerProps>) {
  const handleSelect = useCallback(
    (event: SelectChangeEvent) => {
      const { value } = event.target
      const index = Number(value)
      // '' (no matching option) numbers to 0 — check emptiness before range.
      if (value === '' || !Number.isInteger(index)) return
      if (index < 0 || index >= versions.length) return
      onSelect(index)
    },
    [onSelect, versions],
  )
  return (
    <select
      className="mp-diff-overlay__select"
      value={selectedIndex}
      onChange={handleSelect}
    >
      {versions.map((version, index) => (
        <option key={version.ts} value={index}>
          {versionLabel(version)}
        </option>
      ))}
    </select>
  )
}

interface DiffOverlayViewProps {
  versions: readonly DeepReadonly<PlanVersion>[]
  selectedIndex: number
  onSelect: (index: number) => void
  onClose: () => void
  children: ReactNode
}

/** Focus lands on Close at mount: dismissing is the read-only overlay's
 *  primary action, and it puts Escape (root onKeyDown) within reach. */
function useCloseButtonFocus() {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
  }, [])
  return closeRef
}

/** Escape closes from anywhere. A dialog-scoped onKeyDown would go deaf the
 *  moment focus lands on the body — clicking the read-only diff text does
 *  exactly that — so this is a document listener, scoped to the overlay's
 *  lifetime by the effect cleanup. */
function useEscapeToClose(onClose: () => void) {
  useEffect(() => {
    const handle = (event: DeepReadonly<{ key: string }>) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handle)
    return () => {
      document.removeEventListener('keydown', handle)
    }
  }, [onClose])
}

/** The overlay shell — dialog chrome, version picker, close affordances. Pure
 *  so the DOM tests can render it with a stub pane; the Crepe-owning pane
 *  arrives through `children`. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ReactNode children are React's own element objects; a deep-readonly ReactNode is not expressible.
export function DiffOverlayView({
  versions,
  selectedIndex,
  onSelect,
  onClose,
  children,
}: Readonly<DiffOverlayViewProps>) {
  const closeRef = useCloseButtonFocus()
  useEscapeToClose(onClose)
  return (
    <dialog
      open
      className="mp-diff-overlay"
      aria-modal="true"
      aria-label="Plan changes"
    >
      {/* Pointer convenience; keyboard users close via Escape or Close. */}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div className="mp-diff-overlay__backdrop" onClick={onClose} />
      <div className="mp-diff-overlay__panel">
        <header className="mp-diff-overlay__header">
          <span className="mp-diff-overlay__label">Changes since</span>
          <VersionPicker
            versions={versions}
            selectedIndex={selectedIndex}
            onSelect={onSelect}
          />
          <button
            ref={closeRef}
            type="button"
            className="mp-button mp-diff-overlay__close"
            onClick={onClose}
          >
            Close
          </button>
        </header>
        <div className="mp-diff-overlay__body">{children}</div>
      </div>
    </dialog>
  )
}
