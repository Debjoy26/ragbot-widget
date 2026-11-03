// Bundles the widget into one immutable, versioned IIFE: dist/v<version>/widget.js
import { build, context } from 'esbuild';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const options = {
  entryPoints: [new URL('../src/widget.ts', import.meta.url).pathname],
  outfile: new URL(`../dist/v${pkg.version}/widget.js`, import.meta.url).pathname,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log(`watching widget v${pkg.version}`);
} else {
  await build(options);
  console.log(`built widget v${pkg.version}`);
}
