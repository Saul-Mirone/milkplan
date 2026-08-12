#!/usr/bin/env node
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { HookPayload } from '../shared/protocol'
import { runHook } from './hook'
import { runInit } from './init'
import { runOpen } from './open-command'
import { runUninstall } from './uninstall'
import { VERSION } from './version'

const HELP = `milkplan ${VERSION} — review Claude Code plans in a browser before approving them

Usage:
  milkplan                       Run as a PermissionRequest hook (reads JSON from stdin)
  milkplan hook                  Same as the default command
  milkplan init                  Register the hook in ~/.claude/settings.json
  milkplan init --project        Register in <cwd>/.claude/settings.local.json
                                 (machine-local — keep it out of git)
  milkplan init --project --shared
                                 Register a portable hook in <cwd>/.claude/settings.json
                                 for the whole team (requires an npm install)
  milkplan open [--print] [--all]
                                 Open a review that is waiting (MILKPLAN_OPEN=manual);
                                 --print writes the URLs instead of launching
  milkplan uninstall             Remove milkplan hooks from user and project settings
  milkplan test-fire [--payload <file>]
                                 Fire the real hook path against a sample plan
  milkplan --help                Show this help
  milkplan --version             Print the version
`

// Shipped bundles do not include fixtures/; used when sample-plan.md is absent.
const SAMPLE_PLAN_FALLBACK = `# Sample plan (embedded fallback)

## Goal

Exercise the milkplan review flow end to end without a Claude Code session.

## Steps

1. Start the review server on a random loopback port
2. Open the browser review UI
3. Approve, annotate, or request changes
4. Watch the decision JSON arrive on stdout

## Verification

The process exits 0 and prints a single line of hook JSON after the decision.
`

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function loadSamplePlan(): string {
  try {
    return readFileSync(resolve('fixtures/sample-plan.md'), 'utf8')
  } catch {
    return SAMPLE_PLAN_FALLBACK
  }
}

function createTestFirePlansDir(): string {
  // resolvePlan only accepts plan files under ~/.claude/plans/, so the temp
  // dir must live there for the real transcript-scan path to fire.
  const plansDir = join(homedir(), '.claude', 'plans')
  mkdirSync(plansDir, { recursive: true })
  const tempDir = mkdtempSync(join(plansDir, 'milkplan-test-fire-'))
  // runHook terminates via process.exit; an exit hook is the only reliable
  // place to clean up, and it keeps ~/.claude/plans free of test litter.
  process.on('exit', () => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Best effort: leftover temp dirs are harmless, just noisy.
    }
  })
  return tempDir
}

function writeTestFireTranscript(
  transcriptPath: string,
  planPath: string,
  planMarkdown: string,
): void {
  const transcriptEntry = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_test_fire',
          name: 'Write',
          input: { file_path: planPath, content: planMarkdown },
        },
      ],
    },
  }
  writeFileSync(transcriptPath, `${JSON.stringify(transcriptEntry)}\n`)
}

async function runTestFire(args: readonly string[]): Promise<void> {
  const payloadFlag = args.indexOf('--payload')
  if (payloadFlag !== -1) {
    const payloadPath = args[payloadFlag + 1]
    if (payloadPath === undefined || payloadPath === '') {
      process.stderr.write('[milkplan] --payload requires a file path\n')
      process.exitCode = 1
      return
    }
    let payloadJson: string
    try {
      payloadJson = readFileSync(resolve(payloadPath), 'utf8')
    } catch {
      // Unguarded this surfaced as an unhandled rejection with a stack trace,
      // because main() is invoked as `void main()`. Every other error path
      // here reports one line and sets exitCode.
      process.stderr.write(`[milkplan] could not read ${payloadPath}\n`)
      process.exitCode = 1
      return
    }
    await runHook(payloadJson)
    return
  }

  const planMarkdown = loadSamplePlan()
  const tempDir = createTestFirePlansDir()
  const planPath = join(tempDir, 'sample-plan.md')
  writeFileSync(planPath, planMarkdown)

  const transcriptPath = join(tempDir, 'transcript.jsonl')
  writeTestFireTranscript(transcriptPath, planPath, planMarkdown)

  const payload: HookPayload = {
    session_id: 'milkplan-test-fire',
    transcript_path: transcriptPath,
    cwd: process.cwd(),
    hook_event_name: 'PermissionRequest',
    tool_name: 'ExitPlanMode',
    tool_input: {},
  }
  process.stderr.write(`[milkplan] test-fire: temp plan at ${planPath}\n`)
  await runHook(JSON.stringify(payload))
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP)
    return
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  if (command === 'init') {
    runInit(args.slice(1))
    return
  }
  if (command === 'open') {
    await runOpen(args.slice(1))
    return
  }
  if (command === 'uninstall') {
    runUninstall(args.slice(1))
    return
  }
  if (command === 'test-fire') {
    await runTestFire(args.slice(1))
    return
  }
  if (command === undefined || command === 'hook') {
    await runHook(await readStdin())
    return
  }
  process.stderr.write(`[milkplan] unknown command: ${command}\n\n${HELP}`)
  process.exitCode = 1
}

void main()
