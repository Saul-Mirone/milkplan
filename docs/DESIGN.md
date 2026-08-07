# milkplan — Design Specification

Review, edit, and annotate Claude Code plans in a Milkdown (Crepe) WYSIWYG editor
before approving them. A `PermissionRequest` hook intercepts `ExitPlanMode`, opens a
browser review page, and the user's decision flows back to Claude through the hook
protocol.

Differentiator vs existing tools (Plannotator): the plan is **directly editable** —
"approve with edits" replaces the plan content, instead of only annotate-and-deny.

## Architecture

One process per review. No daemon. Fail-open everywhere.

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
`AnnotationOut`, `DecisionRequest`, `HookAllowOutput`, `HookDenyOutput`,
`TOKEN_HEADER`.

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
5. `startReviewServer` (failure → passthrough), then `openBrowser(url, support,
realLaunchIO, onExhausted)`. Every launcher missing → passthrough; a launcher
   that started but opened nothing → print URL to stderr and keep waiting.
6. SIGINT/SIGTERM → exit 0 silently. Wait indefinitely (hook timeout is the backstop).

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
  `#token=...`, default `dev-token` when absent), render header (plan path, cwd),
  `PlanEditor`, `Sidebar`, `ActionBar`.
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
- Styling: `@milkdown/crepe/theme/common/style.css` + `frame.css`, plus
  `frame-dark.css` behind `prefers-color-scheme: dark`. Two-column layout: editor
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

## Milestones

M1 skeleton+resolution → M2 loop with placeholder UI + REAL-SESSION envelope
verification → M3 Crepe editing → M4 annotations → M5 init/README/polish.
