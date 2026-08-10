// Read from the manifest instead of restated here: `changeset version` edits
// package.json, and init.ts bakes both values into *committed team hooks*, so a
// hand-maintained copy pins whole teams to a package or version that does not
// exist. Named imports (not `import pkg from`) so the bundler can drop the rest
// of the manifest. Both are inlined at build time — nothing reads package.json
// at run time, which matters because this binary runs on every plan approval.
import { name, version } from '../../package.json'

/** Published npm package name, e.g. `@enorim/milkplan`. */
export const PACKAGE_NAME = name

/** CLI version, e.g. `0.0.1`. */
export const VERSION = version
