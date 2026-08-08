import type { ReviewMeta } from '../../shared/protocol'
import type { DeepReadonly } from '../../shared/readonly'

interface ReviewHeaderProps {
  meta: DeepReadonly<ReviewMeta>
  /** 1-based number of the current round; null on the first round. */
  roundNumber: number | null
  /** Opens the diff overlay; null when there are no earlier rounds. */
  onViewChanges: (() => void) | null
}

export function ReviewHeader({
  meta,
  roundNumber,
  onViewChanges,
}: Readonly<ReviewHeaderProps>) {
  return (
    <header className="mp-header">
      <span className="mp-header__brand">milkplan</span>
      <div className="mp-header__meta">
        <span className="mp-header__path" title={meta.planPath ?? undefined}>
          {meta.planPath ?? 'inline plan (no file)'}
        </span>
        <span className="mp-header__cwd" title={meta.cwd}>
          {meta.cwd}
        </span>
      </div>
      {roundNumber !== null && onViewChanges !== null && (
        <div className="mp-header__actions">
          <span className="mp-header__round">Round {roundNumber}</span>
          <button
            type="button"
            className="mp-button mp-button--ghost"
            onClick={onViewChanges}
          >
            View changes
          </button>
        </div>
      )}
    </header>
  )
}
