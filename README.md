# milkplan

Review, **edit**, and annotate Claude Code plans in a [Milkdown](https://milkdown.dev)
WYSIWYG editor before approving them.

When Claude Code finishes planning and asks for approval (`ExitPlanMode`), milkplan
opens the plan in your browser instead of the terminal prompt:

- **Edit the plan directly** — WYSIWYG, in a real markdown editor. Approving sends
  your revised version back to Claude as the authoritative plan (the plan file on
  disk is updated to match).
- **Annotate** — select text, attach comments. Annotations survive concurrent edits
  (they are position-mapped, not text-matched) and orphaned comments keep their
  original excerpt.
- **Approve / Request changes / Skip** — approvals can carry implementation notes;
  rejections send your comments (anchored to quoted excerpts) back to Claude, which
  revises and resubmits. Skip falls back to the normal terminal prompt.

Everything runs locally: an ephemeral HTTP server on `127.0.0.1` with a single-use
token, one process per review, no daemon, no network calls.

## Install

```sh
npm install -g milkplan   # or: use npx below without installing
milkplan init             # writes the hook into ~/.claude/settings.json
```

Per-project installs come in two flavors:

- `milkplan init --project` targets `<cwd>/.claude/settings.local.json`, the
  machine-local settings file, because the hook command can embed absolute paths
  from your machine. init keeps it out of git for you (via `.git/info/exclude`),
  and warns if it is already tracked.
- `milkplan init --project --shared` writes a portable, version-pinned
  `npx -y milkplan@<version>` command into the committed
  `<cwd>/.claude/settings.json` so the whole team gets the hook. It refuses to
  run from a source checkout — a checkout's command only exists on your machine.
  Teammates need `npx` on their PATH, and Claude Code asks them to approve the
  project hook before it first runs.

Re-running `init` is safe: it refreshes a stale milkplan entry in the target
file (old node paths after a version-manager upgrade, an outdated `--shared`
version pin) instead of duplicating it. Hooks in _different_ settings files
stack, though — init warns when a sibling file also runs milkplan.

The hook entry looks like this (the `command` varies by mode — `--shared`
always writes the version-pinned `npx` form shown here; user and `--project`
installs may pin absolute local paths instead, which is why they live in
machine-local files):

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "npx -y milkplan@0.1.0",
            "timeout": 86400
          }
        ]
      }
    ]
  }
}
```

Restart Claude Code after installing. The next time a plan needs approval, your
browser opens with the review UI.

To remove milkplan, clean up the hook entries first, then the package:

```sh
milkplan uninstall        # removes hooks from user + current project settings
npm uninstall -g milkplan
```

(Uninstalling only the package is not enough: a leftover `npx -y milkplan` hook
would silently re-download it from the registry on the next plan approval.)

## How it works

```
Claude Code ──ExitPlanMode──▶ PermissionRequest hook ──▶ milkplan CLI
                                  resolve plan (session transcript → plan file)
                                  serve review UI on 127.0.0.1:<random>#token=…
                                              │
                              you edit / annotate / decide
                                              │
              approve ──▶ allow (+ revised plan via additionalContext,
                          plan file updated on disk)
              request changes ──▶ deny (annotations + feedback → Claude revises)
              skip / any failure ──▶ passthrough to the terminal prompt
```

milkplan is **fail-open**: if the plan can't be located, the server can't start, or
you skip, it exits silently and Claude Code shows its normal approval prompt. The
hook `timeout` is the only thing that bounds how long a review can stay open.

## Development

```sh
pnpm install
pnpm dev          # UI against fixtures — no Claude Code needed
pnpm test         # vitest
pnpm build        # dist/ui (vite) + dist/cli.mjs (tsdown)
pnpm smoke        # test-fire: full hook loop against a synthesized session
```

`milkplan test-fire` exercises the real code path: it synthesizes a session
transcript, resolves it, starts the server, and opens the browser; the decision JSON
lands on stdout exactly as Claude Code would receive it.
Set `MILKPLAN_NO_BROWSER=1` to suppress browser launch in automation.

## Compatibility notes

- **Interactive sessions only.** Headless runs (`claude -p`) do not expose
  `ExitPlanMode` at all — the model prints its plan and stops, so the hook never
  fires (verified empirically). This matches the product's intent: plan review
  needs a human at the keyboard.

- Current Claude Code stores plans as files under `~/.claude/plans/`; milkplan
  locates the session's plan through the transcript. Older versions that pass the
  plan inline (`tool_input.plan`) are also supported.
- Claude does not re-read the plan file after approval, so edited plans are
  delivered through the hook's `additionalContext` (and the file is updated for
  consistency).

## License

MIT
