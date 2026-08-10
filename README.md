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
- **Approve / Request changes / Skip** — approvals can carry implementation notes
  and optionally switch the session's permission mode (auto / accept edits /
  manual); rejections send your comments (anchored to quoted excerpts) back to
  Claude, which revises and resubmits. Skip falls back to the normal terminal
  prompt.
- **Compare rounds** — when Claude revises and resubmits after "Request
  changes", the next review shows a round badge and a "View changes" button:
  a read-only inline diff against any earlier submitted round of the same
  session.

![The milkplan review UI: the plan in a WYSIWYG editor with an annotation anchored to selected text](https://raw.githubusercontent.com/Saul-Mirone/milkplan/HEAD/docs/assets/review-ui.png)

Everything runs locally: an ephemeral HTTP server on `127.0.0.1` with a
per-review token, one process per review, no daemon. The review itself makes no
network calls. As a plugin it is downloaded once and every review after that
runs a local `node`; only the legacy `npx -y @enorim/milkplan` hook command can
reach the npm registry, and only on a cold cache.

## Requirements

- Node.js ≥ 20
- Claude Code with the `PermissionRequest` hook event (verified on v2.1.221;
  the stricter approval envelope required since v2.1.199 is handled
  automatically). Installing as a plugin additionally needs marketplace support
  with an `npm` plugin source — both present in v2.1.220
- An interactive session — headless `claude -p` never reaches plan approval
  (see Compatibility notes)

## Install

From inside a Claude Code session:

```
/plugin marketplace add Saul-Mirone/milkplan
/plugin install milkplan@enorim
```

Restart Claude Code. The next time a plan needs approval, your browser opens
with the review UI.

For a whole team, commit this to `<repo>/.claude/settings.json` instead — every
teammate picks it up on their next session:

```json
{
  "extraKnownMarketplaces": {
    "enorim": {
      "source": { "source": "github", "repo": "Saul-Mirone/milkplan" }
    }
  },
  "enabledPlugins": { "milkplan@enorim": true }
}
```

The plugin id is `milkplan@enorim` — `plugin-name@marketplace-name`, the reverse
of the npm scope order in `@enorim/milkplan`. The marketplace is named after the
namespace rather than this one product, so it has room for the next one.

To remove it: `/plugin uninstall milkplan@enorim`.

### Without the plugin system

milkplan is also a plain npm package that writes the hook into a settings file
itself. Use it if you want `milkplan` as a real terminal command — a plugin's
executables reach only Claude Code's own Bash tool, not your shell — or if your
Claude Code predates plugin marketplaces.

```sh
npm install -g @enorim/milkplan   # or: use npx below without installing
milkplan init             # writes the hook into ~/.claude/settings.json
milkplan test-fire        # verify: your browser opens a sample plan review
```

`test-fire` exercises the full pipeline without a Claude Code session — if the
browser opens and deciding prints a JSON line to the terminal, the install
works.

> **Pick one.** Hooks stack across every source Claude Code reads, and the
> plugin and `init` register the same hook independently — running both opens
> **two** browser windows on every plan approval. Migrating to the plugin? Run
> `milkplan uninstall` first; it is the only thing that removes an entry `init`
> wrote.

Per-project installs come in two flavors:

- `milkplan init --project` targets `<cwd>/.claude/settings.local.json`, the
  machine-local settings file, because the hook command can embed absolute paths
  from your machine. init keeps it out of git for you (via `.git/info/exclude`),
  and warns if it is already tracked.
- `milkplan init --project --shared` writes a portable, version-pinned
  `npx -y @enorim/milkplan@<version>` command into the committed
  `<cwd>/.claude/settings.json` so the whole team gets the hook. It refuses to
  run from a source checkout — a checkout's command only exists on your machine.
  Teammates need `npx` on their PATH, and Claude Code asks them to approve the
  project hook before it first runs. The `enabledPlugins` block above does the
  same job without the `npx` requirement or the version pin to keep current.

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
            "command": "npx -y @enorim/milkplan@0.0.1",
            "timeout": 86400
          }
        ]
      }
    ]
  }
}
```

Restart Claude Code after `init` too — hooks are read at startup.

To remove an `init`-written milkplan, clean up the hook entries first, then the
package:

```sh
milkplan uninstall        # removes hooks from user + current project settings
npm uninstall -g @enorim/milkplan
```

(Uninstalling only the package is not enough: a leftover `npx -y @enorim/milkplan` hook
would silently re-download it from the registry on the next plan approval.)

Uninstalling does not delete review data: the plan text of past rounds stays in
`~/.claude/milkplan/history/` (see Plan history below) — remove that directory
yourself if you don't want to keep it.

## How it works

```
Claude Code ──ExitPlanMode──▶ PermissionRequest hook ──▶ milkplan CLI
                                  resolve plan (planFilePath → transcript → inline)
                                  serve review UI on 127.0.0.1:<random>#token=…
                                              │
                              you edit / annotate / decide
                                              │
              approve ──▶ allow (+ revised plan via additionalContext,
                          plan file updated on disk)
              request changes ──▶ deny (annotations + feedback → Claude revises)
              skip / any failure ──▶ passthrough to the terminal prompt
```

milkplan is **fail-open**: if the plan can't be located, the server can't start, no
browser can be opened, or you skip, it exits silently and Claude Code shows its
normal approval prompt. The hook `timeout` is the only thing that bounds how long a
review can stay open.

## Plan history

When you request changes, Claude revises and resubmits — a new review round in
the same session. milkplan records each round's plan as it was submitted, which
is what powers the "View changes" diff:

- **Where:** `~/.claude/milkplan/history/<session_id>.jsonl`, one round per
  line. Nothing else is stored — no annotations, no decisions.
- **What:** the submitted plan markdown only. Edits you make during review are
  written back to the plan file, so they surface as part of the _next_ round's
  submission — the diff shows everything that changed between two submissions,
  not only Claude's revision.
- **Noise control:** every round is run through the same markdown formatter
  before it is stored, and the diff ignores formatting-only differences such as
  renumbered list items and tight-vs-loose spacing — so a step inserted halfway
  down a numbered list highlights that step, not everything below it. Requesting
  changes also asks Claude to leave sections your feedback doesn't address
  untouched. A round whose only revision was formatting shows up as "no
  changes".
- **Retention:** the review UI is served the last 20 rounds of a session;
  history files untouched for about 30 days are pruned automatically.
- **Failures:** history is best-effort. If it can't be read or written,
  milkplan logs it and the review proceeds normally (the current round's diff
  falls back to in-memory history) — a history failure never blocks a review.

## Troubleshooting

Every hook invocation appends to `~/.claude/milkplan.log` — that file is the
first place to look.

- **Nothing popped up.** Restart Claude Code after installing (hooks are read at
  startup), then check the log. If the hook fired, the log contains
  `review UI at http://127.0.0.1:<port>/#token=…` — open that URL manually. If
  the log has no entry at all, the hook never ran: confirm your Claude Code
  version has `PermissionRequest` hooks, then that the hook is registered —
  `/plugin` should list milkplan as enabled, or the entry should be in the
  settings file `init` reported.
- **Two browser windows per plan.** The plugin and an `init`-written hook are
  both installed. Run `milkplan uninstall` to drop the settings entry.
- **It stopped working after a Node upgrade.** Source-checkout installs pin the
  absolute path of the node binary; when a version manager (fnm/nvm) deletes
  that version, the hook dies silently. Re-run `milkplan init` — it refreshes
  stale entries in place.
- **Closed the tab before deciding.** Recover the URL from the log, or press
  Esc in the terminal to cancel the hook and use the native prompt. The hook
  timeout (24h by default) eventually falls back to the native prompt too.
- **Remote / headless (SSH, containers).** With no display and no `$BROWSER`,
  milkplan passes straight through to the terminal prompt rather than serving a
  UI nobody can reach. To review in a browser anyway, set
  `MILKPLAN_NO_BROWSER=1` so it serves and waits, then forward the port
  (`ssh -L <port>:127.0.0.1:<port> <host>`) and open the URL from the log
  locally. Setting `$BROWSER` works too, and keeps the automatic launch.
- **Skip vs closing the tab.** Skip hands control back to the terminal prompt
  immediately (annotations you typed are discarded); closing the tab leaves
  Claude Code waiting until Esc or the timeout.

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

Two environment variables affect the browser launch:

- `MILKPLAN_NO_BROWSER=1` — serve and wait, but never launch anything. This is
  the automation escape hatch; it never turns into a passthrough.
- `BROWSER` — the command to launch instead of the platform default. It is taken
  as a bare command and handed the URL as a single argument (no `%s` expansion,
  no colon-separated lists). Honored everywhere except native Windows.

## Releasing

Releases are automated with [Changesets](https://github.com/changesets/changesets).

**In a PR that changes behaviour**, describe the change for users:

```sh
pnpm changeset
```

Pick `patch` / `minor` / `major`, write one user-facing sentence, and commit the
generated `.changeset/*.md` file. For refactors, docs, or CI changes that ship
nothing user-visible, skip it (or use `pnpm changeset add --empty`). Nothing
enforces this — a PR without a changeset simply ships in whatever release comes
next.

**Maintainers:** merging to `main` opens a `chore: version packages` PR that bumps
`package.json`, the pinned version in this README, and `.claude-plugin/plugin.json`,
and writes `CHANGELOG.md`. Merging that PR publishes to npm, pushes the `v*` tag, and
cuts the GitHub release. npm auth is
[trusted publishing](https://docs.npmjs.com/trusted-publishers) over OIDC — there is
no npm token in this repo, and releases carry provenance.

`package.json` is the only place the version lives: `src/cli/version.ts` imports it,
and `scripts/sync-version.mjs` moves the two copies no import can reach — the pin
above and the plugin manifest. Never bump any of them by hand; `tests/dist.test.ts`
fails if they drift.

The plugin manifest's version is not cosmetic. Claude Code resolves an `npm`-sourced
plugin's version from `plugin.json` alone — there is no commit SHA to fall back to, and
the fallback for that source is the constant `unknown` — so a manifest stuck at an old
version means `/plugin update` never offers the new one.

The marketplace entry publishes to the same npm package, so nothing about a release
touches `.claude-plugin/marketplace.json`: its `>=` floor is there to exclude the
releases published before the plugin manifests existed.

## Compatibility notes

- **Interactive sessions only.** Headless runs (`claude -p`) do not expose
  `ExitPlanMode` at all — the model prints its plan and stops, so the hook never
  fires (verified empirically). This matches the product's intent: plan review
  needs a human at the keyboard.

- **WSL.** Your browser lives on the Windows side, so milkplan opens it there:
  `wslview` → `powershell.exe Start-Process` → `cmd.exe /c start`, trying the
  next one only when a launcher is not installed. That order holds even under
  WSLg, where `xdg-open` is kept as a last resort; set `BROWSER=xdg-open` to
  prefer a Linux browser instead. The review URL is loopback, which WSL2's
  default `localhostForwarding` (and WSL1's shared network stack, and mirrored
  networking mode) relays into the distro — with `localhostForwarding=false` in
  `.wslconfig` the browser opens but cannot reach the server.

- **No GUI browser.** On a box with no `DISPLAY`, no `WAYLAND_DISPLAY` and no
  `$BROWSER` — SSH sessions, containers — milkplan passes through to the
  terminal prompt instead of holding a port nobody can reach. Same if every
  launcher turns out to be missing (WSL with interop disabled, for instance).
  See Troubleshooting for reviewing over a forwarded port.

- Current Claude Code stores plans as files under `~/.claude/plans/` and passes
  the path in the hook payload (`tool_input.planFilePath`), which milkplan uses
  directly; it falls back to scanning the session transcript, and finally to the
  inline `tool_input.plan` older versions send.
- Claude does not re-read the plan file after approval, so edited plans are
  delivered through the hook's `additionalContext` (and the file is updated for
  consistency).

## License

MIT
