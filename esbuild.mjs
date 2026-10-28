// Junta o TypeScript do processo principal num arquivo só (build/main.cjs). As dependências ficam de fora
// (vão no node_modules do instalador) e o Electron é do próprio runtime.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'build/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external',
  sourcemap: 'inline',
  logLevel: 'info',
});
