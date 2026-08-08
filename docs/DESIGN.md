# milkplan — Design Specification

Review, edit, and annotate Claude Code plans in a Milkdown (Crepe) WYSIWYG editor
before approving them. A `PermissionRequest` hook intercepts `ExitPlanMode`, opens a
browser review page, and the user's decision flows back to Claude through the hook
protocol.

Differentiator vs existing tools (Plannotator): the plan is **directly editable** —
"approve with edits" replaces the plan content, instead of only annotate-and-deny.

## Architecture

One process per review. No daemon. Fail-open everywhere. The only cross-process
state is the plan-history store (`~/.claude/milkplan/history/`, one JSONL file
per session — see `src/cli/history.ts`), and it is fail-open too: any history
failure degrades that round to in-memory history and never blocks the review.

```
Claude Code ──ExitPlanMode──▶ PermissionRequest hook ──stdin JSON──▶ milkplan CLI
                                   │ resolve plan (transcript scan → plan file)
                                   │ start node:http server on 127.0.0.1:<random>
                                   │ open browser
                                   ▼
                         Browser UI (React + Crepe + annotation sidebar)
                                   │ POST /api/decision
                                   ▼
                         CLI writes plan file (if edited),
                         prints hook JSON to stdout, exits 0
```

**Fail-open rule:** on ANY failure (no plan found, server can't start, no browser
launcher is available, every launcher fails to start) the CLI prints nothing to
stdout and exits 0 — Claude Code then falls back to the normal terminal approval
prompt. The UI's "Skip review" button does the same.

**stdout discipline:** the process writes NOTHING to stdout except the final
single-line hook JSON. All logging goes to stderr.

## Verified hook mechanics (constraints, do not re-derive)

- Hook stdin payload: `{session_id, transcript_path, cwd, permission_mode?,
hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_input}`.
- The plan markdown is NOT in `tool_input` in current Claude Code versions. The plan
  lives in a file `~/.claude/plans/<random-name>.md`. Older versions may pass
  `tool_input.plan` inline — support both.
- Session transcripts (`transcript_path`, JSONL) record plan writes as entries whose
  `message.content[]` contains `{type: "tool_use", name: "Write" | "Edit",
input: {file_path: "<home>/.claude/plans/<name>.md", ...}}`.
- After approval Claude does NOT re-read the plan file; edited content must be
  delivered via `additionalContext` in the hook output.

## Module contracts

### `src/shared/protocol.ts` (already written — single source of truth for types)

See the file. Key types: `HookPayload`, `ResolvedPlan`, `ReviewPayload`,
`PlanVersion`, `AnnotationOut`, `DecisionRequest`, `HookAllowOutput`,
`HookDenyOutput`, `TOKEN_HEADER`.

`ReviewPayload.history: readonly PlanVersion[]` — the session's prior submitted
rounds, oldest → newest; the current round is the `plan` field and never repeats
in `history`. A `PlanVersion` is `{ts, round, planPath, markdown}`: the plan as
submitted at hook time, never the reviewer-edited version. `round` is the
1-based round number stamped when first recorded, so labels stay accurate after
the read-time round cap slices old entries off. History is fixed at
hook time and rides the existing `GET /api/review` response — no new endpoint,
zero changes to `server.ts` and `src/ui/api.ts`.

### `src/cli/resolve-plan.ts`

```ts
export interface ResolveIO {
  readFile(path: string): string | null // returns null on any error
  homedir(): string
}
export function resolvePlan(payload: HookPayload, io: ResolveIO): ResolvedPlan
```

Algorithm:

1. Read the transcript via `io.readFile(payload.transcript_path)`; split lines,
   iterate **backwards**, `JSON.parse` each line inside try/catch (skip malformed).
2. Match entries where `entry.message?.content` is an array containing an item with
   `type === 'tool_use'`, `name === 'Write' || name === 'Edit'`, and a string
   `input.file_path` that resolves inside `<homedir>/.claude/plans/` and ends with
   `.md` (expand a leading `~` against `io.homedir()`).
3. On match, `io.readFile(planPath)` — the DISK content is authoritative (an Edit
   entry's input only carries a fragment). If the read fails, keep scanning
   backwards for an earlier plan reference.
4. Fallback 1: non-empty `payload.tool_input?.plan` → `{source: 'inline', markdown}`.
5. Fallback 2: `{source: 'none'}`.

Pure function; no direct fs/os imports so tests can inject `ResolveIO`.

### `src/cli/history.ts` (pure logic + injected IO, mirrors `resolve-plan.ts`)

```ts
export interface HistoryIO {
  readFile(path: string): string | null // any error → null
  mkdir(path: string): void // recursive; may throw
  appendFile(path: string, content: string): void // may throw
  listDir(path: string): string[] | null // missing/unreadable dir → null
  mtimeMs(path: string): number | null // stat failure → null
  removeFile(path: string): void // best-effort, swallows every error
  homedir(): string
  now(): number
  log(message: string): void // never throws
}
export interface RecordRoundInput {
  sessionId: string
  planPath: string | null // null for inline plans
  markdown: string
}
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_ROUNDS = 20

export function historyDirFor(home: string): string // <home>/.claude/milkplan/history
export function historyFileFor(home: string, sessionId: string): string // <dir>/<sessionId>.jsonl
// JSONL parse; blank, malformed, or misshapen lines are silently skipped per line.
export function parseHistory(raw: string): PlanVersion[]
// Persist this round, return the session's versions (old → new, current round
// last, at most MAX_ROUNDS). TOTAL: never throws.
export function recordRound(
  input: DeepReadonly<RecordRoundInput>,
  io: DeepReadonly<HistoryIO>,
): PlanVersion[]
```

One append-only JSONL file per session at
`~/.claude/milkplan/history/<session_id>.jsonl`, one `PlanVersion` per line — a
single `appendFile` per round; O_APPEND atomicity plus per-line parse tolerance
absorbs torn concurrent writes. The file is never rewritten: the `MAX_ROUNDS`
cap is a read-time slice, and disk growth is bounded by the prune. Never writes
into `~/.claude/plans/` (the `resolve-plan.ts` trust boundary — a distinct
directory plus the `.jsonl` suffix).

`recordRound`:

1. Session ids must match `/^[A-Za-z0-9_-]{1,128}$/u` (path-traversal guard;
   real ids are UUIDs, so this branch stays minimal): otherwise log once, do
   zero disk IO, return only the current round.
2. `parseHistory(readFile(file) ?? '')` — ENOENT is an empty history.
3. Consecutive-duplicate dedupe: if the last stored round equals the input
   under `normalizeMarkdown` (`src/shared/markdown.ts`: strip `\r` +
   `trimEnd()`, never per-line trim — shared with the UI's diff precheck),
   return the prior rounds unchanged (original `ts` kept). Only consecutive:
   A→B→A records three rounds.
4. Otherwise append `{ts: now(), planPath, markdown}`; a mkdir/append failure
   is logged and the result is `[...prior, current]` regardless — a read-only
   HOME still gets this round's diff from memory.
5. Prune (own try/catch): sibling `.jsonl` files older than `STALE_AFTER_MS`
   by `mtimeMs` are removed — never the current session's own file (a failed
   append would make it look stale). Runs on every call; a readdir is cheap
   and a throttle marker would itself be corruptible state.

`src/cli/hook-io.ts` exports `realHistoryIO: HistoryIO` and `HookIO` gains
`recordHistory(input: DeepReadonly<RecordRoundInput>): PlanVersion[]` —
`recordRound` over `realHistoryIO`, same total/fail-open contract as `resolve`.

⚠️ **Diff semantics caveat:** only hook-time submissions are stored — the
reviewer-edited version of a round never is. But `onDecision` writes
`editedMarkdown` back to the plan file on both approve and request-changes, so
the next round's submission baseline includes those edits: the diff shows
everything between round N's submission and round N+1's submission — including
the reviewer's write-backs at round N's decision — not only Claude's revision.

### `src/cli/feedback.ts` (pure functions, exact templates)

```ts
export function buildDecisionOutput(
  decision: DecisionRequest,
  plan: ResolvedPlan,
): HookAllowOutput | HookDenyOutput | null // null → passthrough (never happens for valid input)
```

Excerpts are truncated to 200 chars with a trailing `…`. Empty sections are omitted.
Annotation entries are numbered. An orphaned annotation (its anchor text was deleted
during review) renders as:
`Regarding a passage that was removed during review (original text: "<createdExcerpt>")`.

- **Clean approve** (no edits, no annotations, no overall feedback):
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
- **Approve with edits** — allow + `additionalContext` (top level, next to
  `hookSpecificOutput`):

  ```
  The user revised the plan during review. The authoritative version of the plan is now:

  <full revised markdown>

  The plan file at <path> has been updated to match this revision. Follow the revised plan, not the version you originally submitted.
  ```

  (When the plan source is `inline`, drop the middle sentence about the file.)

- **Approve with annotations/overall feedback** — allow + `additionalContext`:

  ```
  The user approved the plan and attached implementation notes anchored to specific parts of the plan:

  1. Regarding: "<excerpt>"
     Note: <comment>

  Overall notes:
  <overallFeedback>

  Follow the plan, and take these notes into account during implementation.
  ```

- **Approve with both:** revised-plan block first, then the notes block, joined by a
  blank line, single `additionalContext` string.
- **Request changes** — deny:

  ```
  The user reviewed the plan and requests changes before approving it.

  Inline comments (each refers to a quoted excerpt from the plan):

  1. Regarding: "<excerpt>"
     Comment: <comment>

  Overall feedback:
  <overallFeedback>

  Revise the plan to address this feedback, then present the updated plan again using ExitPlanMode.
  ```

  If the user also edited the text before requesting changes, append the revised
  markdown under a `The user also directly edited the plan; their edited version:`
  section so the edits are not lost.

⚠️ **Envelope caveat (verify empirically in a real session, M2):** docs disagree on
(a) whether deny nests under `hookSpecificOutput` and (b) whether
`additionalContext` is top-level or inside `hookSpecificOutput`. Implement as typed
in `protocol.ts` (allow/deny both under `hookSpecificOutput`, `additionalContext`
top-level) and keep ALL envelope construction inside `feedback.ts` so a correction
is a one-line change.

### `src/cli/server.ts`

```ts
export interface ReviewSession {
  payload: ReviewPayload
  token: string // required on every /api request
  onDecision(d: DecisionRequest): void
  onSkip(): void
}
// Returns true if the request was handled (an /api/* route), false otherwise.
export function handleApiRequest(
  session: ReviewSession,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean>

export interface RunningServer {
  url: string
  close(): void
}
export function startReviewServer(
  session: ReviewSession,
  uiDir: string, // dist/ui, resolved from import.meta.url
): Promise<RunningServer>
```

| Endpoint        | Method | Body → Response                                         |
| --------------- | ------ | ------------------------------------------------------- |
| `/api/review`   | GET    | → `ReviewPayload` JSON                                  |
| `/api/decision` | POST   | `DecisionRequest` → `{ok:true}`, finalize               |
| `/api/skip`     | POST   | → `{ok:true}`, then passthrough exit                    |
| anything else   | GET    | static file from `uiDir` (SPA fallback to `index.html`) |

- `server.listen(0, '127.0.0.1')`; final URL `http://127.0.0.1:<port>/#token=<token>`
  (fragment, not query — never hits logs).
- Token: `crypto.randomBytes(16).toString('hex')`. Every `/api/*` request must carry
  it in the `x-milkplan-token` header (`TOKEN_HEADER`); otherwise 403. Also reject
  requests whose `Host` header doesn't start with `127.0.0.1`. Rationale: loopback
  binding alone doesn't stop a malicious webpage in the same browser from spraying
  `POST http://127.0.0.1:<port>/...` (drive-by / DNS rebinding).
- Static serving: safe path join (reject `..`), minimal content-type map
  (html/js/css/svg/woff2/map/json), no directory listing.
- `handleApiRequest` must not know about http server lifecycle — the hook composes
  it. This exact function is also mounted by the Vite dev middleware.

### `src/cli/hook.ts`

```ts
export async function runHook(stdinJson: string): Promise<void>
```

1. Parse `HookPayload` (malformed → passthrough).
2. `resolvePlan` with real fs/os IO (`source: 'none'` → passthrough).
3. Build `ReviewSession`:
   - `onDecision`: (a) if `editedMarkdown` present and source is `file`, write it to
     the plan path (best-effort; failure → still proceed, note dropped file update to
     stderr); (b) `buildDecisionOutput`; (c) write single-line JSON + `\n` to stdout;
     (d) close server, `process.exit(0)`.
   - `onSkip`: close server, exit 0 with no output.
4. `detectBrowserSupport` BEFORE binding: `unavailable` → passthrough (a review
   nobody can reach would otherwise hold the port until the hook timeout).
5. `io.recordHistory({sessionId, planPath (null unless source is 'file'),
markdown})` — after the browser-support check, i.e. after every passthrough
   exit (rounds nobody reviews are never recorded) and before the port binds.
   Total/fail-open like `io.resolve`: no try/catch at the call site. The
   returned versions minus their last element (always the current round) become
   `ReviewPayload.history`.
6. `startReviewServer` (failure → passthrough), then `openBrowser(url, support,
realLaunchIO, onExhausted)`. Every launcher missing → passthrough; a launcher
   that started but opened nothing → print URL to stderr and keep waiting.
7. SIGINT/SIGTERM → exit 0 silently. Wait indefinitely (hook timeout is the backstop).

Passthrough = print nothing, `process.exit(0)`.

### `src/cli/open-browser.ts`

Pure decision + thin spawner, so every branch is unit-testable without spawning
anything or trusting the host OS:

```ts
detectBrowserSupport(env: BrowserEnv): BrowserSupport   // pure
buildCandidates(support, url): readonly Candidate[]     // pure
openBrowser(url, support, io: LaunchIO, onExhausted?): void
```

`BrowserSupport` is `suppressed` (MILKPLAN_NO_BROWSER — serve, never launch,
never passthrough), `unavailable` (→ passthrough), or `available` with an ordered
launcher chain:

| env                             | chain                                                                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| darwin                          | `$BROWSER?` → `open <url>`                                                                                                                                              |
| win32                           | `cmd.exe /c start "" <url>` (`$BROWSER` not honored)                                                                                                                    |
| WSL                             | `$BROWSER?` → `wslview` → `powershell.exe -NoProfile -NonInteractive -Command "Start-Process '<url>'"` → `cmd.exe /c start "" <url>` → `xdg-open` (only with a display) |
| linux w/ display                | `$BROWSER?` → `xdg-open <url>`                                                                                                                                          |
| linux w/o display or `$BROWSER` | `unavailable`                                                                                                                                                           |

WSL is detected on `platform === 'linux'` plus `WSL_DISTRO_NAME`, `WSL_INTEROP`,
or a lowercased `os.release()` containing `microsoft` (WSL1 capitalizes it). The
Windows launchers precede `xdg-open` even under WSLg because the user's browser
is on the Windows side.

The chain advances **only** on the spawn `error` event (the launcher is not
installed). Exit codes are ignored: they disagree across launchers — `start`
returns as soon as it hands off and `explorer.exe` returns 1 even on success,
which is why `explorer.exe` is not in the chain at all. Launchers still run
`spawn(..., {detached: true, stdio: 'ignore'}).unref()` and never throw.

Every candidate must carry the URL's `#token=` fragment verbatim; the UI falls
back to `DEV_TOKEN` without it, which yields a page that loads and then 403s.

### `src/cli/init.ts`

`milkplan init [--project [--shared]]` — idempotently merge the hook entry
into the target settings file:

- no flags → `~/.claude/settings.json` (user-level).
- `--project` → `<cwd>/.claude/settings.local.json`. The command may embed
  machine-specific absolute paths, so it goes in Claude Code's machine-local
  file; init ignores the file via `.git/info/exclude` when needed and warns if
  git already tracks it.
- `--project --shared` → `<cwd>/.claude/settings.json` (committed, team-wide).
  Only the portable, version-pinned `npx -y milkplan@<version>` command is
  allowed here: init refuses to run from a source checkout, and an
  `isMachineSpecific` guard blocks absolute/home/env-dependent commands from
  ever reaching the shared file.

The merged entry:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [{ "type": "command", "command": "<cmd>", "timeout": 86400 }]
      }
    ]
  }
}
```

`<cmd>` = `npx -y milkplan` if invoked from an installed package, else the quoted
absolute `"<node>" "<path-to-dist/cli.mjs>"`; `--shared` always uses
`npx -y milkplan@<version>`. Re-running init refreshes a stale milkplan entry in
the target file (remove-then-add; "nothing to do" only when the entry is already
identical). After a project install, warn when a sibling settings file (or the
user-level file) also runs milkplan — hooks stack across files. Log the target
path and command on stderr. Create the file if missing; preserve all unrelated
keys.

`milkplan uninstall` — strip milkplan hook entries (matched by command
substring, plus this install's exact command for checkouts not named
"milkplan") from `~/.claude/settings.json`, `<cwd>/.claude/settings.json`, and
`<cwd>/.claude/settings.local.json`, preserving everything else and pruning
emptied structures.

### `src/cli/index.ts`

Shebang `#!/usr/bin/env node`. Arg router:

- no args (or `hook`): read stdin fully → `runHook`.
- `init [--project [--shared]]`
- `uninstall`
- `test-fire [--payload <file>]`: copy `fixtures/sample-plan.md` to a temp dir,
  synthesize a transcript JSONL containing a Write tool_use pointing at the copy,
  synthesize a `HookPayload` pointing at that transcript, then call `runHook` with
  it — i.e. exercise the REAL code path (server up, browser opens, decision JSON on
  stdout). In the published bundle fixtures aren't shipped; embed the sample plan
  string as a fallback constant.
- `--help` / `--version`.

### UI (`src/ui`, React 19 + Vite)

- `main.tsx` → `App.tsx`: fetch `/api/review` (token from `location.hash`
  `#token=...`, default `dev-token` when absent), render `ReviewHeader` (plan
  path, cwd, round badge), `PlanEditor`, `Sidebar`, `ActionBar`, and — while
  `diffOpen` — `DiffOverlay` fed with `payload.history` and `payload.plan` (the
  submitted current round, never the live edited document).
- `PlanEditor.tsx`: `useEffect`+ref wrapping a `Crepe` instance.
  - `new Crepe({root, defaultValue: plan, features: {[Crepe.Feature.ImageBlock]:
false, [Crepe.Feature.Latex]: false}, featureConfigs: {[Crepe.Feature.Toolbar]:
{buildToolbar}}})`.
  - `buildToolbar(builder)`: add group `annotate` with one item — icon 💬 (inline
    SVG), `onRun(ctx)` reads the current `TextSelection` from `editorViewCtx` and
    opens the comment popover for that range.
  - Register the annotation feature BEFORE `create()`:
    `crepe.addFeature(annotationFeature, {onChange})`.
  - After `create()`: `baseline = await crepe.getMarkdown()`; expose
    `getMarkdown()` and `isEdited()` (compare against baseline — NEVER against the
    original file: the parse→serialize roundtrip is not byte-stable, but
    serializer-to-serializer comparison is self-normalizing).
  - Destroy on unmount.
- `annotations/plugin.ts` (pure ProseMirror, NO React imports):
  - `PluginKey<AnnotationState>('MILKPLAN_ANNOTATION')`.
  - State: `{annotations: AnnotationRecord[], decorations: DecorationSet,
activeId: string | null}` where `AnnotationRecord = {id, from, to, comment,
createdExcerpt, orphaned, pending}`.
  - Actions via `tr.setMeta(key, action)`: `begin | commit | remove | setActive`.
  - Two-phase lifecycle: opening the comment popover dispatches `begin`
    (record enters plugin state with `pending: true` and an empty comment) so
    the range is remapped through every transaction WHILE the popover is open —
    Save (`commit`) can never anchor to stale positions, and deleting the
    selected text meanwhile orphans the pending record like any other. Cancel
    dispatches `remove`. Pending records are excluded from the sidebar and from
    decision serialization, and render with a dashed `--pending` decoration.
  - `apply(tr, prev)`: for every transaction remap all records
    `from = tr.mapping.map(from, 1)`, `to = tr.mapping.map(to, -1)`; if
    `from >= to` → `orphaned: true` (keep the record; `createdExcerpt` still
    serializes on deny). Rebuild `DecorationSet` from non-orphaned records:
    `Decoration.inline(from, to, {class: 'mp-annotation' (+ ' mp-annotation--active'
for activeId), 'data-annotation-id': id})`.
  - `props.decorations` returns the set; `props.handleClickOn` resolves
    `[data-annotation-id]` from the event target and dispatches `setActive`.
  - `view()` hook invokes `config.onChange(state)` after each update so React can
    subscribe.
  - Import PM types from `@milkdown/kit/prose/state` and `@milkdown/kit/prose/view`.
- `annotations/feature.ts`: `DefineFeature`-shaped wrapper —
  `(editor, config) => editor.use($prose(() => createAnnotationPlugin(config)))`
  with `$prose` from `@milkdown/kit/utils`.
- `hooks/useAnnotations.ts`: `useSyncExternalStore` bridge over the plugin's
  onChange; exposes `annotations`, `activeId`, and command dispatchers (given a
  view getter): `addAnnotation(from, to, comment)`, `removeAnnotation(id)`,
  `setActive(id)` — each dispatches the corresponding meta transaction. Excerpts for
  display/serialization come from `doc.textBetween(from, to)` at read time
  (`createdExcerpt` when orphaned).
- `Sidebar.tsx`: annotation cards (excerpt quote + comment + delete; click →
  `setActive` + scroll editor via `view.coordsAtPos`), orphaned badge, overall
  feedback `<textarea>`.
- `ActionBar.tsx`: **Approve** (collects `editedMarkdown` only if `isEdited()`,
  annotations, overall feedback → POST decision `approve`), **Request changes**
  (requires ≥1 annotation or non-empty overall feedback; POST `request-changes`),
  **Skip review** (POST `/api/skip`). After 200: replace the app with a "Decision
  sent — you can close this tab" screen (state swap in App).
- `CommentPopover.tsx`: absolutely positioned near the selection
  (`view.coordsAtPos(from)`), textarea + Save/Cancel; Save dispatches `add`.
- `components/ReviewHeader.tsx`: the header (plan path or "inline plan (no
  file)", cwd) plus `roundNumber: number | null` and `onViewChanges: (() =>
void) | null` — both non-null render a right-aligned `Round {n}` badge and a
  "View changes" button; first round / no history hides the entry entirely.
- `history.ts`: `versionLabel(version)` → `"Round 2 · 14:32"`, numbered from
  the version's recorded `round` (pure; tests assert structure, not
  timezone-specific output).
- `diff/feature.ts`: `diffFeature(editor)` — Crepe feature adapter registering
  `@milkdown/kit/plugin/diff` + `@milkdown/kit/component/diff` before
  `create()`; sets `customBlockTypes: ['table', 'image-block', 'code_block']`
  so decorations reach Crepe's custom node views. `diffConfig` keeps its
  shipped default, which already ignores Crepe's volatile heading ids.
- `components/DiffOverlay.tsx`: read-only diff modal (`role="dialog"`,
  `aria-modal`; Escape via a document-level listener scoped to the overlay's
  lifetime by its effect cleanup — a dialog-scoped handler goes deaf once a
  click on the read-only text drops focus to the body; backdrop click and a
  Close button, focused on mount, also dismiss).
  A version `<select>` (labels via `versionLabel`) defaults to the previous
  round and resets on every open; switching versions remounts the pane via a
  React key. The pane is a SECOND read-only Crepe instance — the main editor is
  never touched, so in-flight edits and annotations survive open/close.
  Bootstrap: `defaultValue` = the selected old round, then
  `startDiffReviewCmd(currentMarkdown)`. A `normalizeMarkdown` equality
  precheck short-circuits to "no changes" (starting the diff on an identical
  document yields zero changes yet still locks the editor); after start,
  `getPendingChanges(state).length === 0` also means "no changes";
  `startDiffReviewCmd` returning `false` (markdown parse failure) → error
  notice. The per-block Accept/Reject controls have no config switch and are
  hidden by CSS (`.mp-diff-overlay` rules; a dist canary asserts the rule
  ships).
- Styling: `@milkdown/crepe/theme/common/style.css` + `nord.css`, plus
  `nord-dark.css` behind `prefers-color-scheme: dark`. Two-column layout: editor
  (flex-1, max-width ~860px) + sidebar (320px). `.mp-annotation {background:
rgba(255, 212, 0, .35)}`, `--active` variant stronger.

### Dev mode (`vite.config.ts`, already written)

Vite dev server mounts the REAL `handleApiRequest` via `configureServer`, backed by
`fixtures/sample-plan.md`, token `dev-token`; decisions are pretty-printed to the
terminal instead of stdout. `pnpm dev` develops the full UI with zero Claude Code
involvement.

## Testing

- `tests/resolve-plan.test.ts`: injected `ResolveIO` + `fixtures/transcript*.jsonl`:
  Write-entry hit; Edit-entry reads disk (not transcript fragment); most-recent
  wins; malformed lines skipped; unreadable plan file falls back to earlier entry;
  no entry + `tool_input.plan` → inline; nothing → none; `~` expansion.
- `tests/feedback.test.ts`: every template branch incl. orphaned annotations,
  truncation, edits+deny combination. Inline snapshots.
- `tests/server.test.ts`: boot `startReviewServer` on port 0 with a temp uiDir,
  drive with `fetch`: 403 without token, review payload roundtrip, decision flow
  invokes `onDecision`, skip invokes `onSkip`, path traversal on static route is
  rejected.
- `tests/open-browser.detect.test.ts`: injected `BrowserEnv` — suppression,
  per-platform chains, `$BROWSER` precedence, headless verdict, WSL via each of
  the three signals (incl. WSL1's capitalized kernel string), WSLg ordering, and
  the negatives (stock kernel, WSL vars on native win32).
- `tests/open-browser.test.ts`: argv per launcher (PowerShell quoting, `start`'s
  empty title arg, `#token=` survives everywhere) and chain behavior against a
  fake `LaunchIO` — stop on first success, advance past a missing launcher,
  report exhaustion once, and never launch or report exhaustion when suppressed.
- `tests/history.test.ts`: injected `HistoryIO` (in-memory fake fs): first
  round makes the dir + exactly one append; ordering (old → new, current round
  last); consecutive dedupe (incl. CRLF-only differences) vs A→B→A recording
  three rounds; malformed-line matrix (skipped, good lines kept); mkdir/append
  failure still returns `[...prior, current]` with exactly one log; invalid
  session ids do zero disk IO; the `MAX_ROUNDS` cap; prune (stale siblings
  removed, fresh kept, the session's own file never removed, non-`.jsonl`
  skipped). Plus a direct `parseHistory` matrix.
- `tests/history-view.test.ts`: `versionLabel` structure
  (`/^Round \d+ · \d{1,2}:\d{2}/`) — no timezone-specific assertions.
- `tests/dom/review-header.test.tsx`: plan path / cwd rendering with the
  "inline plan (no file)" fallback; `roundNumber: null` hides badge and button;
  non-null shows `Round {n}` and the button fires `onViewChanges` exactly once.
- `tests/dom/diff-overlay.test.tsx`: the `DiffOverlayView` shell only (real
  Crepe stays out of happy-dom): one option per version labeled via
  `versionLabel`, select value / `onSelect` (invalid values ignored),
  Escape / backdrop / Close dismissal, dialog a11y attributes, initial focus.
- `tests/hook.test.ts` asserts `recordHistory` runs with the right input on the
  happy path (and `planPath: null` for inline plans) and never runs on
  passthrough exits; `tests/hook.e2e.test.ts` drives the real binary across
  rounds of one session (request changes → next round's `/api/review` carries
  the prior round in `history`, the `.jsonl` file grows, an unchanged
  resubmission dedupes); `tests/dist.test.ts` asserts the built CSS ships the
  `.mp-diff-overlay` Accept/Reject-hiding rule (the read-only guarantee's
  canary).

## Milestones

M1 skeleton+resolution → M2 loop with placeholder UI + REAL-SESSION envelope
verification → M3 Crepe editing → M4 annotations → M5 init/README/polish.
