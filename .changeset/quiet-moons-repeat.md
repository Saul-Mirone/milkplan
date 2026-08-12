---
'@enorim/milkplan': patch
---

Add `MILKPLAN_OPEN` so the review no longer has to arrive unannounced. `background`
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
