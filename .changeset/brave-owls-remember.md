---
'@enorim/milkplan': patch
---

Refreshing the review page no longer throws your work away. Annotations, edits
to the plan, and the overall feedback are saved as a draft (in the browser's
localStorage, debounced behind your typing) and restored when the page loads —
a reload, a second tab, or `milkplan open` after closing the tab all come back
to where you left off. Deciding (approve, request changes, or skip) clears the
draft; abandoned drafts expire after 30 days.

Restored annotations are validated against the text they were anchored to: a
draft from an earlier round is ignored rather than restored against the wrong
plan, and a record whose anchor no longer matches comes back as an orphan
instead of highlighting the wrong words.
