import type { Editor } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { highlight, highlightPluginConfig } from '@milkdown/plugin-highlight'
import { createParser, type Parser } from '@milkdown/plugin-highlight/shiki'
import {
  bundledLanguages,
  getSingletonHighlighter,
  type BundledLanguage,
  type Highlighter,
} from 'shiki'

import type { DeepReadonly } from '../../shared/readonly'

function isBundledLanguage(lang: string): lang is BundledLanguage {
  return lang in bundledLanguages
}

// Grammars bundled eagerly; anything else lazy-loads from shiki's full bundle.
const PRELOADED_LANGS = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'json',
  'jsonc',
  'toml',
  'bash',
  'shellscript',
  'yaml',
  'python',
  'go',
  'rust',
  'css',
  'html',
  'markdown',
  'sql',
  'diff',
]

export function loadHighlighter(): Promise<Highlighter> {
  return getSingletonHighlighter({
    themes: ['github-light', 'github-dark'],
    langs: PRELOADED_LANGS,
  })
}

export interface HighlightFeatureConfig {
  highlighter: Readonly<Highlighter>
}

/**
 * Wraps the shiki parser so a single code block can never break the rest:
 * the upstream parser throws on languages the highlighter has not loaded,
 * and prosemirror-highlight aborts the WHOLE decoration pass on the first
 * throw — one unknown fence would kill highlighting for every block after
 * it. Unknown-but-bundled languages are lazy-loaded instead (returning a
 * Promise makes the plugin refresh once the grammar arrives); anything
 * else is silently skipped.
 */
function createSafeParser(
  highlighter: Readonly<Highlighter>,
  theme: string,
): Parser {
  const base = createParser(highlighter, { theme })
  // Per-language load state. While a grammar load is in flight the parser
  // must keep returning the SAME promise: the plugin caches array results
  // (an early [] would freeze the block as unhighlighted forever — Crepe
  // dispatches transactions during init, so recalcs race the load), but it
  // leaves promise results uncached and refreshes when they resolve.
  const loads = new Map<string, { promise: Promise<void>; done: boolean }>()
  return (options: Readonly<Parameters<Parser>[0]>) => {
    const language = options.language?.toLowerCase()
    if (language === undefined || language === '') return []
    try {
      return base({ ...options, language })
    } catch {
      if (!isBundledLanguage(language)) return []
      let state = loads.get(language)
      if (!state) {
        const entry = { promise: Promise.resolve(), done: false }
        entry.promise = highlighter
          .loadLanguage(language)
          .catch(() => {})
          .then(() => {
            entry.done = true
          })
        loads.set(language, entry)
        state = entry
      }
      // done + still throwing = the grammar is genuinely unusable; give up
      // (returning the settled promise instead would refresh-loop forever).
      return state.done ? [] : state.promise
    }
  }
}

/**
 * Replaces Crepe's CodeMirror code blocks with read-friendly shiki
 * highlighting (decoration-based — the document itself stays untouched).
 */
export function highlightFeature(
  editor: DeepReadonly<Editor>,
  config?: Readonly<HighlightFeatureConfig>,
): void {
  if (!config) return
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const parser = createSafeParser(
    config.highlighter,
    dark ? 'github-dark' : 'github-light',
  )
  editor
    .config((ctx: DeepReadonly<Ctx>) => {
      ctx.set(highlightPluginConfig.key, { parser })
    })
    .use(highlight)
}
