import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const repoRoot = path.resolve(packageRoot, '..', '..', '..');
const requireFromStudio = createRequire(path.join(repoRoot, 'studio', 'package.json'));
const esbuild = requireFromStudio('esbuild');
const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const analyze = args.has('--analyze');

const options = {
  entryPoints: [path.join(packageRoot, 'src/viewport.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  tsconfigRaw: {
    compilerOptions: {
      jsx: 'react',
    },
  },
  outfile: path.join(packageRoot, 'viewport.js'),
  sourcemap: false,
  metafile: analyze,
  legalComments: 'none',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[wt_rendering] watching TypeScript viewport sources');
} else {
  const result = await esbuild.build(options);
  if (analyze && result.metafile) {
    const output = path.join(packageRoot, 'viewport.js');
    const outputMeta = result.metafile.outputs[output] || result.metafile.outputs[path.relative(process.cwd(), output)];
    const bytes = outputMeta?.bytes ?? 0;
    console.log(`[wt_rendering] viewport bundle: ${(bytes / 1024).toFixed(1)} KiB`);
    console.log(await esbuild.analyzeMetafile(result.metafile, { verbose: false }));
  }
}
