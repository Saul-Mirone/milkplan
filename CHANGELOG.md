# @enorim/milkplan

## 0.0.2

### Patch Changes

- [#8](https://github.com/Saul-Mirone/milkplan/pull/8) [`9c8f937`](https://github.com/Saul-Mirone/milkplan/commit/9c8f93780066fc09ce8b0fcb0ce05f53bcd953f1) Thanks [@Saul-Mirone](https://github.com/Saul-Mirone)! - Ship milkplan as a Claude Code plugin. Install it with `/plugin marketplace add Saul-Mirone/milkplan` then `/plugin install milkplan@enorim`, or share it with a team through `enabledPlugins` in a committed `.claude/settings.json` — no absolute paths, no `npx` on anyone's PATH. The npm package and `milkplan init` keep working; run `milkplan uninstall` before enabling the plugin, since the two register the same hook and every plan approval would otherwise open two reviews.
