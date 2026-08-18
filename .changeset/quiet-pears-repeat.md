---
'@enorim/milkplan': patch
---

Fix code blocks keeping the theme they were loaded with. Everything else in the
review page followed the OS switching between light and dark, but the syntax
colors were picked once at editor setup and baked into decorations nothing could
invalidate afterwards. Every token now carries both palettes and CSS chooses at
paint time, so a code block re-themes with the rest of the page.

The bottom bar also gets a theme button, cycling System → Light → Dark, if you
would rather not review a plan in whatever your OS happens to be set to. The
choice is remembered for later reviews.
