// Controlled regression variant: omit only the new session-identity transition.
// Source files are unchanged. Rebuild the normal widget immediately afterward.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../../../', import.meta.url);
await build({
  entryPoints: [fileURLToPath(new URL('widget/src/widget.ts', root))],
  outfile: fileURLToPath(new URL('widget/dist/v1.0.0/widget.js', root)),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  plugins: [
    {
      name: 'omit-session-rebinding',
      setup(builder) {
        builder.onLoad({ filter: /[\\/]widget[\\/]src[\\/]widget\.ts$/ }, async ({ path }) => {
          const source = await readFile(path, 'utf8');
          const start = source.indexOf('if (boundSessionToken !== session.token) {');
          const end = source.indexOf('creatingSession = false;', start);
          if (start < 0 || end < start) throw new Error('baseline markers missing');
          return { contents: source.slice(0, start) + source.slice(end), loader: 'ts' };
        });
      },
    },
  ],
});
console.log(
  'Controlled A07 identity-transition variant built; rebuild normal widget after red run.',
);
