import { computeDocDiff } from '@milkdown/kit/plugin/diff'
import { Schema, type Node } from '@milkdown/kit/prose/model'
import { describe, expect, it } from 'vitest'

import { listIgnoreAttrs, mergeIgnoreAttrs } from '../src/ui/diff/ignore-attrs'

/**
 * The diff matches block children by a signature built from their attrs, so
 * which attrs count as identity decides whether an untouched section repaints.
 * These suites drive computeDocDiff directly — no DOM, no Crepe, no shiki —
 * against a schema that replicates the list attrs Crepe actually has
 * (preset-commonmark's list nodes plus preset-gfm's `checked`).
 */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    bullet_list: {
      group: 'block',
      content: 'list_item+',
      attrs: { spread: { default: false } },
      toDOM: () => ['ul', 0],
    },
    ordered_list: {
      group: 'block',
      content: 'list_item+',
      attrs: { order: { default: 1 }, spread: { default: false } },
      toDOM: () => ['ol', 0],
    },
    list_item: {
      content: 'paragraph+',
      attrs: {
        label: { default: '•' },
        listType: { default: 'bullet' },
        spread: { default: true },
        checked: { default: null },
      },
      toDOM: () => ['li', 0],
    },
    text: {},
  },
  marks: {
    emphasis: { attrs: { marker: { default: '*' } }, toDOM: () => ['em', 0] },
  },
})

/** What the diff pane computes in production. */
const IGNORE = mergeIgnoreAttrs({ heading: ['id'] }, listIgnoreAttrs())
/** What it computed before this fix, kept to pin the behaviour being fixed. */
const SHIPPED_ONLY = { heading: ['id'] }

function para(text: string): Node {
  return schema.node('paragraph', null, text === '' ? [] : [schema.text(text)])
}

/** An ordered item as the parser builds it: label carries the ordinal. */
function orderedItem(ordinal: number, text: string): Node {
  return schema.node(
    'list_item',
    { label: `${ordinal}.`, listType: 'ordered', spread: false },
    [para(text)],
  )
}

function orderedList(...texts: readonly string[]): Node {
  return schema.node(
    'ordered_list',
    null,
    texts.map((text, i) => orderedItem(i + 1, text)),
  )
}

function bulletList(spread: boolean, ...texts: readonly string[]): Node {
  return schema.node(
    'bullet_list',
    { spread },
    texts.map((text) => schema.node('list_item', { spread }, [para(text)])),
  )
}

function doc(
  // ProseMirror's Node is a mutable class and schema.node only accepts it;
  // nothing here writes to the blocks.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  ...blocks: Node[]
): Node {
  return schema.node('doc', null, blocks)
}

describe('diff ignoreAttrs — ordered list renumbering', () => {
  // The reported symptom: insert one step into a numbered plan and every later
  // step renders as changed, because its label went "3." → "4.".
  const before = doc(para('Steps'), orderedList('Alpha', 'Beta', 'Gamma'))
  const after = doc(
    para('Steps'),
    orderedList('Alpha', 'Beta', 'Inserted', 'Gamma'),
  )

  it('reports a single change when one numbered step is inserted', () => {
    const changes = computeDocDiff(before, after, { ignoreAttrs: IGNORE })
    expect(changes).toHaveLength(1)
  })

  it('cascades across every renumbered step without the fix', () => {
    const changes = computeDocDiff(before, after, {
      ignoreAttrs: SHIPPED_ONLY,
    })
    expect(changes.length).toBeGreaterThan(1)
  })
})

describe('diff ignoreAttrs — tight/loose reformatting', () => {
  const tight = doc(bulletList(false, 'one', 'two', 'three'))
  const loose = doc(bulletList(true, 'one', 'two', 'three'))

  it('reports no change when only list spacing differs', () => {
    expect(computeDocDiff(tight, loose, { ignoreAttrs: IGNORE })).toHaveLength(
      0,
    )
  })

  it('repaints the list without the fix', () => {
    expect(
      computeDocDiff(tight, loose, { ignoreAttrs: SHIPPED_ONLY }).length,
    ).toBeGreaterThan(0)
  })
})

describe('diff ignoreAttrs — attrs deliberately kept as identity', () => {
  it('still reports a changed checkbox', () => {
    const unchecked = doc(
      schema.node('bullet_list', null, [
        schema.node('list_item', { checked: false }, [para('todo')]),
      ]),
    )
    const checked = doc(
      schema.node('bullet_list', null, [
        schema.node('list_item', { checked: true }, [para('todo')]),
      ]),
    )
    expect(
      computeDocDiff(unchecked, checked, { ignoreAttrs: IGNORE }).length,
    ).toBeGreaterThan(0)
  })

  it('still reports a changed ordered-list start number', () => {
    const from1 = doc(orderedList('Alpha'))
    const from5 = doc(
      schema.node('ordered_list', { order: 5 }, [orderedItem(5, 'Alpha')]),
    )
    expect(
      computeDocDiff(from1, from5, { ignoreAttrs: IGNORE }).length,
    ).toBeGreaterThan(0)
  })

  it('still reports a bullet list converted to an ordered one', () => {
    // listType is ignored on the item, but the parent node type is not, so the
    // conversion is still caught.
    const bullets = doc(bulletList(false, 'Alpha'))
    const ordered = doc(orderedList('Alpha'))
    expect(
      computeDocDiff(bullets, ordered, { ignoreAttrs: IGNORE }).length,
    ).toBeGreaterThan(0)
  })
})

describe('diff — the trailing paragraph the diff pane suppresses', () => {
  const plan = doc(para('Intro'), bulletList(false, 'one', 'two'))

  it('reports nothing for identical docs ending in a list', () => {
    expect(computeDocDiff(plan, plan, { ignoreAttrs: IGNORE })).toHaveLength(0)
  })

  it('reports a deletion when only the old side carries an empty trailing paragraph', () => {
    // This is what Crepe's trailing plugin adds to the old-side doc and the
    // parsed new-side doc never has — hence trailingConfig.shouldAppend being
    // neutralized in src/ui/diff/feature.ts.
    const withTrailing = doc(
      para('Intro'),
      bulletList(false, 'one', 'two'),
      para(''),
    )
    const changes = computeDocDiff(withTrailing, plan, { ignoreAttrs: IGNORE })
    expect(changes).toHaveLength(1)
  })
})

describe('diff — emphasis marker style is mark identity', () => {
  it('repaints the run, which no ignoreAttrs setting can prevent', () => {
    // encodeMark folds every non-null mark attr into the per-character token
    // and takes no ignore config, so `_hi_` vs `*hi*` is a change at this
    // layer. Production avoids it upstream: canonicalizeMarkdown puts both
    // rounds in one marker style before either is parsed.
    const underscore = doc(
      schema.node('paragraph', null, [
        schema.text('hi', [schema.mark('emphasis', { marker: '_' })]),
      ]),
    )
    const asterisk = doc(
      schema.node('paragraph', null, [
        schema.text('hi', [schema.mark('emphasis', { marker: '*' })]),
      ]),
    )
    expect(
      computeDocDiff(underscore, asterisk, { ignoreAttrs: IGNORE }).length,
    ).toBeGreaterThan(0)
  })
})

describe('mergeIgnoreAttrs', () => {
  it('keeps node types the caller did not mention', () => {
    expect(mergeIgnoreAttrs({ heading: ['id'] }, {}).heading).toEqual(['id'])
  })

  it('unions the two lists on a colliding node type', () => {
    expect(
      mergeIgnoreAttrs({ list_item: ['label'] }, { list_item: ['spread'] })
        .list_item,
    ).toEqual(['label', 'spread'])
  })

  it('does not repeat an entry present in both', () => {
    expect(
      mergeIgnoreAttrs({ list_item: ['spread'] }, { list_item: ['spread'] })
        .list_item,
    ).toEqual(['spread'])
  })

  it('returns fresh arrays rather than aliasing the config it was handed', () => {
    const prev = { heading: ['id'] }
    const merged = mergeIgnoreAttrs(prev, listIgnoreAttrs())
    expect(merged.heading).not.toBe(prev.heading)
  })
})
