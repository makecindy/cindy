// Check production CJS bundling, then load every command without executing it.
import { mkdtemp, rm, symlink, readdir, readFile } from "node:fs/promises";
import { gzipSync } from 'node:zlib';
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "cindy-recipes-bundle-"));
try {
  await symlink(
    path.join(root, "node_modules"),
    path.join(output, "node_modules"),
    "dir",
  );
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    plugins: [{
      name: 'assert-static-recipe-entry',
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type === 'chunk' && output.dynamicImports.length) {
            throw new Error(`Recipe bundle retained runtime imports: ${output.fileName}`);
          }
          if (output.type !== 'chunk') continue;
          for (const id of Object.keys(output.modules)) {
            if (!id.includes('/packages/opencli-vendor/') || id.endsWith('/cindy/host.ts')) continue;
            const ast = this.getModuleInfo(id)?.ast;
            if (!ast) continue;
            const fsBindings = new Map();
            for (const node of ast.body) {
              if (node.type !== 'ImportDeclaration' || !/^node:fs(?:\/promises)?$|^fs(?:\/promises)?$/.test(node.source.value)) continue;
              for (const spec of node.specifiers) fsBindings.set(spec.local.name,
                spec.type === 'ImportSpecifier' ? spec.imported.name : '');
            }
            const chain = node => node?.type === 'Identifier' ? [node.name]
              : node?.type === 'MemberExpression' && !node.computed ? [...chain(node.object), node.property.name] : [];
            const guarded = (node, name = 'recipeOutputPath') => node?.type === 'CallExpression'
              && node.callee.name === name;
            const visit = node => {
              if (!node || typeof node !== 'object') return;
              if (node.type === 'CallExpression') {
                const parts = chain(node.callee);
                if (parts[0] === 'console' || (parts[0] === 'process'
                  && ['stdout', 'stderr'].includes(parts[1]) && parts[2] === 'write')) {
                  throw new Error(`Recipe retained host terminal output: ${path.relative(root, id)} (${parts.join('.')})`);
                }
                if (fsBindings.has(parts[0])) {
                  const method = (fsBindings.get(parts[0]) || parts.at(-1)).replace(/Sync$/, '');
                  if (['stat', 'lstat', 'exists', 'access', 'readdir'].includes(method) && !guarded(node.arguments[0])) {
                    throw new Error(`Unbrokered filesystem inspection in bundled recipe: ${path.relative(root, id)} (${method})`);
                  }
                  if (method === 'open' && node.arguments[1]?.value !== 'r' && !guarded(node.arguments[0])) {
                    throw new Error(`Unbrokered output descriptor in bundled recipe: ${path.relative(root, id)}`);
                  }
                  if (['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'link', 'createWriteStream', 'fchmod', 'truncate'].includes(method)) {
                    const args = node.arguments;
                    const firstGuard = ['copyFile', 'link'].includes(method) ? 'recipeCopySource' : 'recipeOutputPath';
                    if (!guarded(args[0], firstGuard) || (['rename', 'copyFile', 'link'].includes(method) && !guarded(args[1]))) {
                      throw new Error(`Unbrokered filesystem write in bundled recipe: ${path.relative(root, id)} (${method})`);
                    }
                  }
                }
              }
              for (const [key, value] of Object.entries(node)) {
                if (key === 'parent') continue;
                if (Array.isArray(value)) value.forEach(visit);
                else if (value && typeof value === 'object') visit(value);
              }
            };
            visit(ast);
          }
        }
      },
    }],
    ssr: { noExternal: true },
    build: {
      ssr: "packages/opencli-vendor/cindy/index.ts",
      outDir: output,
      emptyOutDir: false,
      minify: true,
      rollupOptions: {
        external: ['ws', 'bufferutil', 'utf-8-validate'],
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
          chunkFileNames: "[name]-[hash].cjs",
          manualChunks(id) {
            if (id.includes("/packages/opencli-vendor/"))
              return id.endsWith("/cli-manifest.json") || id.endsWith('/cindy/catalog.ts') || id.endsWith('/cindy/selection.json')
                ? "browser-recipe-catalog"
                : "browser-recipes";
          },
        },
      },
    },
  });
  const require = createRequire(import.meta.url);
  const { catalog, loadAdapter } = require(path.join(output, "index.cjs"));
  for (const entry of catalog) await loadAdapter(`${entry.site}/${entry.name}`);
  const chunks = [];
  for (const name of await readdir(output)) {
    if (!name.endsWith('.cjs')) continue;
    const bytes = await readFile(path.join(output, name));
    chunks.push({ name, bytes: bytes.length, gzipBytes: gzipSync(bytes).length });
  }
  console.log(JSON.stringify({ ok: true, bundledCommands: catalog.length, chunks,
    bytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
    gzipBytes: chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
    note: 'Isolated adapter build, including reachable dependencies; not the complete installer delta or Cindy JSON recipes.' }));
} finally {
  await rm(output, { recursive: true, force: true });
}
