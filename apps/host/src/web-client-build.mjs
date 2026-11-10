import { fileURLToPath } from 'node:url';

/** Compile the browser adapter with the same shared contract as Desktop.
 * Returned in memory: no generated file, profile access, or renderer build.
 */
export async function buildWebShim(entry) {
  // Production serves a prebuilt shim. esbuild is a development dependency and
  // must not be loaded just to start an installed Host.
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    // apps/web reuses the renderer and has no separate workspace install.
    nodePaths: [fileURLToPath(new URL('../node_modules', import.meta.url))],
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}
