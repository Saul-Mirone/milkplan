---
'@enorim/milkplan': patch
---

Self-host the fonts the Crepe nord theme asks for. The theme names Rubik, Inter,
and JetBrains Mono but ships none of them, so headings were falling back to a
Times serif and body text to Arial. The latin and latin-ext subsets are now
bundled locally (no CDN, so the review UI still renders offline), and CJK text
routes to a locale-appropriate system stack led by `system-ui`.
