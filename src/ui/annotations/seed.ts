import type { Node } from '@milkdown/kit/prose/model'

import type { DeepReadonly } from '../../shared/readonly'
import type { AnnotationRecord } from './plugin'

/**
 * A persisted annotation to rebuild at editor init (e.g. from a review
 * draft). `expectedExcerpt` is the doc text of [from, to) captured when the
 * seed was written — NOT `createdExcerpt`, which goes stale as soon as the
 * reviewer edits inside the range.
 */
export interface AnnotationSeed {
  id: string
  from: number
  to: number
  comment: string
  createdExcerpt: string
  orphaned: boolean
  expectedExcerpt: string
}

function seedRecord(
  // ProseMirror's Node is a mutable class; only reads happen here.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  doc: Node,
  seed: DeepReadonly<AnnotationSeed>,
): AnnotationRecord {
  const record: AnnotationRecord = {
    id: seed.id,
    from: seed.from,
    to: seed.to,
    comment: seed.comment,
    createdExcerpt: seed.createdExcerpt,
    orphaned: seed.orphaned,
    pending: false,
  }
  if (record.orphaned) return record
  try {
    const anchored =
      seed.from >= 0 &&
      seed.from < seed.to &&
      seed.to <= doc.content.size &&
      doc.textBetween(seed.from, seed.to) === seed.expectedExcerpt
    return anchored ? record : { ...record, orphaned: true }
  } catch {
    // textBetween throws on positions that fall outside text content.
    return { ...record, orphaned: true }
  }
}

/**
 * Rebuilds committed records from persisted seeds. Positions are only trusted
 * while the doc text they span still matches the seed's expected excerpt —
 * anything else is demoted to an orphan, which keeps its createdExcerpt for
 * the sidebar and serialization exactly like a live orphan. Re-anchoring a
 * mismatched seed by searching the doc for its excerpt is possible future
 * work; a mismatch requires a serializer round-trip instability, and short
 * or repeated excerpts make the search ambiguous.
 */
export function seedRecords(
  // ProseMirror's Node is a mutable class; only reads happen here.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  doc: Node,
  seeds: readonly DeepReadonly<AnnotationSeed>[],
): AnnotationRecord[] {
  return seeds.map((seed) => seedRecord(doc, seed))
}
