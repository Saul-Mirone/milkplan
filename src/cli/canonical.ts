import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { unified } from 'unified'

import { normalizeMarkdown } from '../shared/markdown'

/**
 * Prettier's (and therefore oxfmt's) markdown canon: `-` bullets, `_emphasis_`,
 * `**strong**`, `---` rules. Matching a formatter the user already runs keeps
 * write-backs from fighting whatever formats the plan file later.
 */
const processor = unified()
  .use(remarkParse)
  // Plans routinely carry tables and task lists; without gfm they parse as
  // paragraphs and the round-trip mangles them.
  .use(remarkGfm)
  // Without this a leading `---` block parses as a thematic break plus loose
  // text rather than frontmatter, and comes back rewritten.
  .use(remarkFrontmatter)
  .use(remarkStringify, {
    bullet: '-',
    emphasis: '_',
    strong: '*',
    rule: '-',
  })

/**
 * Rewrites markdown into one canonical form so that two rounds of the same
 * plan differ only where their content differs.
 *
 * Every string that reaches the diff — the submitted plan, each stored round,
 * and anything written back to the plan file — passes through here, because
 * style drift between Claude's output and the editor's serializer otherwise
 * shows up as changes in sections nobody touched. Emphasis markers matter most:
 * they land on ProseMirror marks, and the diff encoder has no way to ignore
 * mark attrs, so `*x*` vs `_x_` would repaint the whole run.
 *
 * Trailing whitespace is trimmed via normalizeMarkdown, matching the canon the
 * round-equality checks already use: most consumers embed the result in prose
 * (the deny message, the revised-plan block), and the one that wants a final
 * newline is the plan-file write, which adds its own.
 *
 * Idempotent, and total: formatting is an enhancement, so anything remark
 * cannot handle is passed through rather than failing the review.
 */
export function canonicalizeMarkdown(markdown: string): string {
  try {
    return normalizeMarkdown(String(processor.processSync(markdown)))
  } catch {
    return normalizeMarkdown(markdown)
  }
}
