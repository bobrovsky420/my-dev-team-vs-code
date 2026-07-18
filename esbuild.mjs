/**
 * Production bundle build. Mirrors the old esbuild CLI invocation (see the
 * package.json `package` script) plus the `md-glob` plugin, which expands
 * `glob:./dir/*.md` imports into inlined string arrays so the config folders
 * (config/models, config/tools) are discovered at build time instead of being
 * hardcoded import lists.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { mdGlobModule } from './md-glob.mjs';

const mdGlob = {
  name: 'md-glob',
  setup(build) {
    build.onResolve({ filter: /^glob:/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.slice('glob:'.length)),
      namespace: 'md-glob',
    }));
    build.onLoad({ filter: /.*/, namespace: 'md-glob' }, (args) => {
      const { dir, code } = mdGlobModule(args.path);
      return { contents: code, loader: 'js', watchDirs: [dir] };
    });
  },
};

await build({
  // Three bundles: the extension host entry, and two engine sidecar child
  // entries (plain Node processes - they never import `vscode`): the IPC one
  // this extension forks, and the stdio (NDJSON) one a non-Node client (the
  // IntelliJ plugin) spawns. The `{ in, out }` form names them
  // dist/extension.js, dist/sidecar.js, and dist/sidecar-stdio.js.
  entryPoints: [
    { in: 'src/extension.ts', out: 'extension' },
    { in: 'src/sidecar/main.ts', out: 'sidecar' },
    { in: 'src/sidecar/stdioMain.ts', out: 'sidecar-stdio' },
  ],
  bundle: true,
  outdir: 'dist',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  loader: { '.md': 'text' },
  plugins: [mdGlob],
  logLevel: 'info',
});
