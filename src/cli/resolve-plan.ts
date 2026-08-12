import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import type { HookPayload, ResolvedPlan } from '../shared/protocol'
import type { DeepReadonly } from '../shared/readonly'

/** Injectable IO so resolvePlan stays pure and testable. */
export interface ResolveIO {
  /** Returns null on any read error. */
  readFile(path: string): string | null
  homedir(): string
}

/** The real filesystem, kept beside its interface the way realLaunchIO is. */
export const realResolveIO: ResolveIO = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  homedir,
}

function expandHome(filePath: string, home: string): string {
  if (filePath === '~') return home
  if (filePath.startsWith('~/')) return join(home, filePath.slice(2))
  return filePath
}

/**
 * Returns the resolved plan path when the transcript content item is a
 * Write/Edit tool_use targeting a .md file inside <home>/.claude/plans/.
 */
function planPathFrom(item: unknown, home: string): string | null {
  if (typeof item !== 'object' || item === null) return null
  const use = item as {
    type?: unknown
    name?: unknown
    input?: { file_path?: unknown }
  }
  if (use.type !== 'tool_use') return null
  if (use.name !== 'Write' && use.name !== 'Edit') return null
  const raw = use.input?.file_path
  if (typeof raw !== 'string') return null
  const expanded = resolve(expandHome(raw, home))
  const plansDir = resolve(home, '.claude', 'plans')
  if (!expanded.startsWith(plansDir + sep)) return null
  if (!expanded.endsWith('.md')) return null
  return expanded
}

/**
 * Validates a plan-file path from tool_input: must live inside
 * <home>/.claude/plans/ and end with .md — same trust boundary as the
 * transcript scan (a hook input must never become an arbitrary write target,
 * since the resolved path is later written back to on approve-with-edits).
 */
function directPlanPath(
  payload: DeepReadonly<HookPayload>,
  home: string,
): string | null {
  const raw = payload.tool_input?.planFilePath
  if (typeof raw !== 'string') return null
  const expanded = resolve(expandHome(raw, home))
  const plansDir = resolve(home, '.claude', 'plans')
  if (!expanded.startsWith(plansDir + sep)) return null
  if (!expanded.endsWith('.md')) return null
  return expanded
}

/** Safely reads `entry.message.content` from an unknown transcript line. */
function messageContentOf(entry: unknown): unknown {
  if (typeof entry !== 'object' || entry === null) return undefined
  if (!('message' in entry)) return undefined
  const message = entry.message
  if (typeof message !== 'object' || message === null) return undefined
  if (!('content' in message)) return undefined
  return message.content
}

/**
 * Reads a plan file, treating a blank one as unreadable. An empty file is not
 * a plan: without this, a truncated or half-written plan file would win over a
 * perfectly good `tool_input.plan` and open the review on a blank editor.
 */
function readPlanFile(
  io: DeepReadonly<ResolveIO>,
  path: string,
): string | null {
  const markdown = io.readFile(path)
  if (markdown === null || markdown.trim() === '') return null
  return markdown
}

export function resolvePlan(
  payload: DeepReadonly<HookPayload>,
  io: DeepReadonly<ResolveIO>,
): ResolvedPlan {
  // Newest Claude Code versions (observed on v2.1.221) hand us the plan file
  // directly in tool_input — no transcript archaeology needed.
  const direct = directPlanPath(payload, io.homedir())
  if (direct !== null) {
    const markdown = readPlanFile(io, direct)
    if (markdown !== null) return { source: 'file', path: direct, markdown }
  }

  const transcript = io.readFile(payload.transcript_path)
  if (transcript !== null) {
    const home = io.homedir()
    const lines = transcript.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (line === undefined || line.trim() === '') continue
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const content = messageContentOf(entry)
      if (!Array.isArray(content)) continue
      for (let j = content.length - 1; j >= 0; j--) {
        const planPath = planPathFrom(content[j], home)
        if (planPath === null) continue
        // Disk content is authoritative (an Edit entry only carries a
        // fragment); on read failure keep scanning for an earlier reference.
        const markdown = readPlanFile(io, planPath)
        if (markdown === null) continue
        return { source: 'file', path: planPath, markdown }
      }
    }
  }

  const inline = payload.tool_input?.plan
  if (typeof inline === 'string' && inline.trim() !== '')
    return { source: 'inline', markdown: inline }

  return { source: 'none' }
}
