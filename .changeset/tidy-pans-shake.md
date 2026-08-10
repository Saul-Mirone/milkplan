---
'@enorim/milkplan': patch
---

Ship milkplan as a Claude Code plugin. Install it with `/plugin marketplace add Saul-Mirone/milkplan` then `/plugin install milkplan@enorim`, or share it with a team through `enabledPlugins` in a committed `.claude/settings.json` — no absolute paths, no `npx` on anyone's PATH. The npm package and `milkplan init` keep working; run `milkplan uninstall` before enabling the plugin, since the two register the same hook and every plan approval would otherwise open two reviews.
