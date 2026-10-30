/** Shared by development and Linux distribution builds. */
export const headlessBuildOptions = {
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  loader: { '.md': 'text' },
  // Bundled ESM dependencies call createRequire(import.meta.url) on startup.
  // Resolve relative to the delivered CLI, not the build machine or its cwd.
  define: { 'import.meta.url': '__headlessModuleUrl' },
  banner: { js: 'const __headlessModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
};
