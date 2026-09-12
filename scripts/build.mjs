import { build } from 'esbuild';
await build({
  entryPoints: ['manifest.ts'],
  outfile: 'dist/manifest.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
});
