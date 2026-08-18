import type { DeepReadonly } from '../../src/shared/readonly'
import { DRAFT_VERSION, hashPlan, type ReviewDraft } from '../../src/ui/draft'

const DEFAULT_ANNOTATIONS: DeepReadonly<ReviewDraft['annotations']> = [
  {
    id: 'a1',
    from: 17,
    to: 22,
    comment: 'why quick?',
    createdExcerpt: 'quick',
    orphaned: false,
    savedExcerpt: 'quick',
  },
]

/** A structurally complete draft; override per test. */
export function makeDraft(
  overrides: DeepReadonly<Partial<ReviewDraft>> = {},
): ReviewDraft {
  return {
    version: DRAFT_VERSION,
    planHash: hashPlan('# Plan'),
    savedAt: 1_700_000_000_000,
    markdown: '# Plan\n\nEdited.',
    baseline: '# Plan\n',
    overallFeedback: 'looks fine',
    ...overrides,
    annotations: (overrides.annotations ?? DEFAULT_ANNOTATIONS).map(
      (annotation) => ({ ...annotation }),
    ),
  }
}
