import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  // dist/ui is produced by `vite build`; never wipe it.
  clean: false,
  dts: false,
})
