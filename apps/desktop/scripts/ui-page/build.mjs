import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import esbuild from 'esbuild';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import loadConfig from 'tailwindcss/loadConfig.js';

export const desktop = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const root = path.resolve(desktop, '../..');
const renderer = path.join(desktop, 'src/renderer');
const harness = fileURLToPath(new URL('./harness/', import.meta.url));
// Never written: esbuild needs an output directory to name assets; files are served from memory.
const outdir = path.join(root, 'artifacts/ui-check/.bundle');
// Assets stay separate files (like Vite) so unicode-range font subsets load on demand.
const assetLoaders = Object.fromEntries(
  ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'woff', 'woff2', 'ttf', 'otf'].map((ext) => [
    `.${ext}`,
    'file',
  ]),
);
const SOURCE = /\.[cm]?[jt]sx?$/;
// Inputs `--compare` can take from another revision: source, styles, translations and assets.
const ASSET = new RegExp(`(?:${Object.keys(assetLoaders).join('|').replaceAll('.', '\\.')})$`);
const OVERLAY = /\.(?:[cm]?[jt]sx?|css|json|png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf)$/;
const loaderFor = (file) =>
  ASSET.test(file)
    ? 'file'
    : file.endsWith('.css')
      ? 'css'
      : file.endsWith('.json')
        ? 'json'
        : /x$/.test(file)
          ? 'tsx'
          : 'ts';
const CONTENT_TYPES = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

const withoutExtension = (file) =>
  file.replace(/\.(?:[cm]?[jt]sx?)$/, '').replace(/[\\/]index$/, '');

function sourceFile(base) {
  const file = ['.ts', '.tsx', '.js', '/index.ts', '/index.tsx']
    .map((suffix) => base + suffix)
    .find((candidate) => existsSync(candidate));
  if (!file) throw new Error(`Stub target not found: ${path.relative(desktop, base)}`);
  return file;
}

/**
 * Stub keys are paths relative to apps/desktop (`src/renderer/x/y`), matched after resolution.
 * Values: `'code'` replaces the module, `'./file.ts'` replaces it with a file next to the page,
 * `{ partial: 'code' }` keeps every real export and overrides only the names declared in code.
 */
function stubTable(definition) {
  return new Map(
    Object.entries(definition.stubs ?? {}).map(([key, value]) => {
      const target = path.join(desktop, key);
      const real = sourceFile(target);
      if (typeof value === 'object') {
        if (typeof value?.partial !== 'string') throw new Error(`Stub ${key}: { partial: 'code' }`);
        return [
          withoutExtension(real),
          {
            key,
            kind: 'partial',
            code: `export * from ${JSON.stringify(real)};\n${value.partial}`,
          },
        ];
      }
      const file = /^\.\.?\//.test(value) ? path.resolve(definition.dir, value) : null;
      if (file && !existsSync(file)) throw new Error(`Stub file not found: ${file}`);
      return [
        withoutExtension(real),
        { key, kind: file ? 'file' : 'replace', file, code: file ? null : value },
      ];
    }),
  );
}

function boundaries(stubs, replaced, overlay) {
  return {
    name: 'ui-page-boundaries',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.namespace === 'ui-stub') return undefined;
        let candidate;
        if (args.path.startsWith('@/')) candidate = path.join(renderer, args.path.slice(2));
        else if (/^\.\.?\//.test(args.path) && args.resolveDir)
          candidate = path.resolve(args.resolveDir, args.path);
        if (!candidate) return undefined;
        const stub = stubs.get(withoutExtension(candidate));
        if (!stub) {
          // --compare: resolve as the old revision would (moved, deleted or re-extensioned files).
          const old = overlay?.resolve(candidate);
          return old ? { path: old } : undefined;
        }
        const importers = (replaced[stub.key] ??= { kind: stub.kind, importers: [] }).importers;
        const importer = path.relative(desktop, args.importer);
        if (!importers.includes(importer)) importers.push(importer);
        return { path: stub.key, namespace: 'ui-stub', pluginData: stub };
      });
      build.onLoad({ filter: /.*/, namespace: 'ui-stub' }, async (args) => {
        const stub = args.pluginData;
        return stub.file
          ? {
              contents: await readFile(stub.file, 'utf8'),
              loader: 'tsx',
              resolveDir: path.dirname(stub.file),
              watchFiles: [stub.file],
            }
          : { contents: stub.code, loader: 'tsx', resolveDir: desktop };
      });
      if (overlay)
        build.onLoad({ filter: OVERLAY }, (args) => {
          const contents = overlay.get(args.path);
          return contents === undefined
            ? undefined
            : { contents, loader: loaderFor(args.path), resolveDir: path.dirname(args.path) };
        });
    },
  };
}

const sourcePath = (file) => path.resolve(root, file.replace(/ with \{[^}]*\}$/, ''));

// Bundle Vite's ?worker imports as real module workers, including --compare
// sources. Keep their inputs in the page fingerprint and affected-page scan.
function workerModules(definition, overlay, inputs, outputs) {
  return {
    name: 'ui-page-workers',
    setup(build) {
      build.onResolve({ filter: /\?worker$/ }, args => ({
        path: path.resolve(args.resolveDir, args.path.slice(0, -7)), namespace: 'ui-worker',
      }));
      build.onLoad({ filter: /.*/, namespace: 'ui-worker' }, async args => {
        const result = await esbuild.build({
          ...common(definition, [boundaries(new Map(), {}, overlay)]),
          entryPoints: [args.path], entryNames: 'worker-[hash]',
        });
        for (const file of Object.keys(result.metafile.inputs)) inputs.add(sourcePath(file));
        outputs.push(...result.outputFiles);
        const script = result.outputFiles.find(file => file.path.endsWith('.js'));
        if (!script) throw new Error(`Worker did not emit JavaScript: ${args.path}`);
        const url = `./${path.relative(outdir, script.path).split(path.sep).join('/')}`;
        return { contents: `export default class extends Worker { constructor(options) { super(new URL(${JSON.stringify(url)}, import.meta.url), { ...options, type: 'module' }); } }`, loader: 'js' };
      });
    },
  };
}

function entryContents(definition) {
  const entry = path.resolve(definition.dir, definition.entry);
  return {
    entry,
    contents: `import ${JSON.stringify(path.join(harness, 'preamble.ts'))};\nimport ${JSON.stringify(entry)};\n`,
  };
}

const common = (definition, plugins) => ({
  absWorkingDir: root,
  bundle: true,
  write: false,
  metafile: true,
  outdir,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  tsconfig: path.join(desktop, 'tsconfig.json'),
  // Lets entries outside the repository (agent scratch files) resolve desktop dependencies.
  nodePaths: [path.join(desktop, 'node_modules'), path.join(root, 'node_modules')],
  loader: assetLoaders,
  assetNames: 'assets/[name]-[hash]',
  publicPath: '/',
  define: {
    'import.meta.env.PROD': 'true',
    'import.meta.env.DEV': 'false',
    'import.meta.env.MODE': '"production"',
    'process.env.NODE_ENV': '"production"',
  },
  logLevel: 'silent',
  plugins,
});

const globalsPath = path.join(renderer, 'styles/globals.css');
const configPath = path.join(desktop, 'tailwind.config.ts');

/** Stylesheets every page is built with (globals.css and its imports) and the Tailwind config. */
let sharedStyles;
async function sharedStyleInputs() {
  sharedStyles ??= esbuild
    .build({
      absWorkingDir: root,
      bundle: true,
      write: false,
      metafile: true,
      outdir,
      loader: assetLoaders,
      logLevel: 'silent',
      stdin: {
        contents: await readFile(globalsPath, 'utf8'),
        loader: 'css',
        resolveDir: path.dirname(globalsPath),
      },
    })
    .then((result) => [
      globalsPath,
      configPath,
      ...Object.keys(result.metafile.inputs)
        .filter((file) => file !== '<stdin>')
        .map(sourcePath),
    ]);
  return sharedStyles;
}

/** Everything a page is built from; used to decide which pages a changed file affects. */
export async function scanPage(definition) {
  const replaced = {};
  const workerInputs = new Set();
  const { contents } = entryContents(definition);
  const result = await esbuild.build({
    ...common(definition, [workerModules(definition, undefined, workerInputs, []), boundaries(stubTable(definition), replaced)]),
    stdin: { contents, resolveDir: root, sourcefile: 'ui-page-entry.ts', loader: 'ts' },
    entryNames: 'page',
  });
  return {
    inputs: [
      ...Object.keys(result.metafile.inputs)
        .filter((file) => !file.startsWith('ui-stub:') && !file.startsWith('ui-worker:') && file !== 'ui-page-entry.ts')
        .map(sourcePath),
      ...workerInputs,
      ...(await sharedStyleInputs()),
    ],
    replaced,
  };
}

/**
 * Builds the selected page from current source every time (no cached bundle).
 * `overlay` (--compare) supplies another revision's contents: `has(file)`, `get(file)` and
 * `resolve(path)` for files that revision imports but the worktree no longer has.
 */
export async function buildPage(definition, overlay) {
  const replaced = {};
  const workerInputs = new Set();
  const workerOutputs = [];
  const { contents, entry } = entryContents(definition);
  const result = await esbuild.build({
    ...common(definition, [workerModules(definition, overlay, workerInputs, workerOutputs), boundaries(stubTable(definition), replaced, overlay)]),
    stdin: { contents, resolveDir: root, sourcefile: 'ui-page-entry.ts', loader: 'ts' },
    entryNames: 'page',
  });
  const inputs = [...new Set([...Object.keys(result.metafile.inputs)
    .filter((file) => !file.startsWith('ui-stub:') && !file.startsWith('ui-worker:') && file !== 'ui-page-entry.ts')
    .map(sourcePath), ...workerInputs])];
  // Tailwind scans exactly the imported source (and overlay text in compare mode).
  const config = loadConfig(configPath);
  const scanned = inputs.filter(
    (file) => !file.includes(`${path.sep}node_modules${path.sep}`) && SOURCE.test(file),
  );
  config.content = [
    ...scanned.filter((file) => !overlay?.has(file)),
    ...scanned
      .filter((file) => overlay?.has(file))
      .map((file) => ({ raw: overlay.get(file), extension: path.extname(file).slice(1) })),
  ];
  const globals = await postcss([tailwind(config)]).process(
    overlay?.get(globalsPath) ?? (await readFile(globalsPath, 'utf8')),
    { from: globalsPath },
  );
  const styles = await esbuild.build({
    ...common(definition, overlay ? [boundaries(new Map(), {}, overlay)] : []),
    stdin: { contents: globals.css, loader: 'css', resolveDir: path.dirname(globalsPath) },
    entryNames: 'styles',
  });
  const files = new Map();
  for (const output of [...result.outputFiles, ...styles.outputFiles, ...workerOutputs]) {
    const url = `/${path.relative(outdir, output.path).split(path.sep).join('/')}`;
    files.set(url, {
      contentType: CONTENT_TYPES[path.extname(output.path)] ?? 'application/octet-stream',
      body: Buffer.from(output.contents),
    });
  }
  const styleInputs = Object.keys(styles.metafile.inputs)
    .filter((file) => file !== '<stdin>')
    .map(sourcePath);
  const watched = [
    ...new Set(
      [
        ...inputs,
        ...styleInputs,
        ...Object.values(definition.stubs ?? {})
          .filter((value) => typeof value === 'string' && /^\.\.?\//.test(value))
          .map((value) => path.resolve(definition.dir, value)),
        globalsPath,
        configPath,
        definition.file,
        path.join(root, 'pnpm-lock.yaml'),
      ].filter(Boolean),
    ),
  ].sort();
  const digest = createHash('sha256');
  const fingerprints = new Map();
  for (const file of watched) {
    const content = overlay?.get(file) ?? (await readFile(file));
    const hash = createHash('sha256').update(content).digest('hex');
    fingerprints.set(file, hash);
    digest.update(path.relative(root, file)).update('\0').update(hash);
  }
  const bundle = createHash('sha256');
  for (const [url, file] of [...files].sort()) bundle.update(url).update(file.body);
  return {
    entry,
    files,
    styles: ['/styles.css', ...(files.has('/page.css') ? ['/page.css'] : [])],
    inputs,
    styleInputs: [globalsPath, ...styleInputs],
    replaced,
    fingerprints,
    sourceDigest: digest.digest('hex'),
    bundleDigest: bundle.digest('hex'),
    inputCount: watched.length,
  };
}

export async function inputsChanged(fingerprints) {
  for (const [file, previous] of fingerprints) {
    try {
      if (
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex') !== previous
      )
        return true;
    } catch {
      return true;
    }
  }
  return false;
}
