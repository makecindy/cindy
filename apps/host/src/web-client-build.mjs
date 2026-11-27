import { fileURLToPath } from 'node:url';

/** Compile the browser adapter with the same shared contract as Desktop.
 * Returned in memory: no generated file, profile access, or renderer build.
 */
/**
 * The shim imports the Desktop's TapDB collector table (shared/endpoints.ts), whose module also
 * reads two Vite build values. A browser IIFE has no `import.meta.env`; without these the shim
 * would throw on load. The shim uses neither value.
 */
export const WEB_SHIM_DEFINE = {
  'import.meta.env.VITE_ENDPOINT_MANIFEST_BASE_URL': 'undefined',
  'import.meta.env.VITE_ENDPOINT_MANIFEST_PEER_BASE_URL': 'undefined',
};

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
    define: WEB_SHIM_DEFINE,
  });
  return result.outputFiles[0].text;
}
