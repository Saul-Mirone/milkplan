# @enorim/milkplan

## 0.0.4

### Patch Changes

- [#11](https://github.com/Saul-Mirone/milkplan/pull/11) [`9a238d4`](https://github.com/Saul-Mirone/milkplan/commit/9a238d46fdde43de73da84feb1879d076737d116) Thanks [@Saul-Mirone](https://github.com/Saul-Mirone)! - Add `MILKPLAN_OPEN` so the review no longer has to arrive unannounced. `background`
  opens the tab without letting your browser steal focus (macOS), and `manual` opens
  nothing at all — the review waits until you run the new `milkplan open` (or
  `npx -y @enorim/milkplan open` on a plugin install, where `milkplan` is not on your
  PATH). Useful if you leave Claude Code working in a background terminal and would
  rather a window did not jump in front of you.

  `milkplan open` takes `--print` (write the URLs instead of launching, which is also
  the nicer recipe for reviewing over an SSH port-forward) and `--all`. Because
  milkplan now records every running review, `milkplan open` also gets you back into
  one whose tab you closed by accident, rather than digging the URL out of
  `~/.claude/milkplan.log`.

  Closing the terminal of a waiting review now also cleans up after itself: the hook
  handles `SIGHUP` alongside `SIGINT`/`SIGTERM`.

## 0.0.3

### Patch Changes

- [`005b8f4`](https://github.com/Saul-Mirone/milkplan/commit/005b8f4a6bfb3c58a46edab845ce5afd7e6270ed) Thanks [@Saul-Mirone](https://github.com/Saul-Mirone)! - Self-host the fonts the Crepe nord theme asks for. The theme names Rubik, Inter,
  and JetBrains Mono but ships none of them, so headings were falling back to a
  Times serif and body text to Arial. The latin and latin-ext subsets are now
  bundled locally (no CDN, so the review UI still renders offline), and CJK text
  routes to a locale-appropriate system stack led by `system-ui`.

## 0.0.2

### Patch Changes

- [#8](https://github.com/Saul-Mirone/milkplan/pull/8) [`9c8f937`](https://github.com/Saul-Mirone/milkplan/commit/9c8f93780066fc09ce8b0fcb0ce05f53bcd953f1) Thanks [@Saul-Mirone](https://github.com/Saul-Mirone)! - Ship milkplan as a Claude Code plugin. Install it with `/plugin marketplace add Saul-Mirone/milkplan` then `/plugin install milkplan@enorim`, or share it with a team through `enabledPlugins` in a committed `.claude/settings.json` — no absolute paths, no `npx` on anyone's PATH. The npm package and `milkplan init` keep working; run `milkplan uninstall` before enabling the plugin, since the two register the same hook and every plan approval would otherwise open two reviews.
