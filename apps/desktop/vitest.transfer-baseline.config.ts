/**
 * Transfer baseline runner config. Reuses the Desktop unit-test environment (Electron
 * stub, user-data setup, aliases) but runs only the baseline entry, in one fork, with
 * timeouts sized for a full loopback session. Not part of the unit tier.
 *
 * `@/` means the renderer for Desktop code and Mobile `src` for the Mobile recovery
 * core this runner imports, so the alias is resolved per importer.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import desktop from './vitest.config';

const desktopRoot = __dirname;
const rendererSrc = path.join(desktopRoot, 'src', 'renderer');
const mobileSrc = path.resolve(desktopRoot, '..', 'mobile', 'src');
const mobileMarker = '/apps/mobile/src/';
const baseAlias = desktop.resolve?.alias as Record<string, string>;

const isFile = (file: string) => statSync(file, { throwIfNoEntry: false })?.isFile() === true;

function resolveAt(importer: string | undefined, id: string): string | null {
  // Vite importer ids use forward slashes on every platform.
  const base = importer?.replace(/\\/g, '/').includes(mobileMarker) ? mobileSrc : rendererSrc;
  for (const candidate of [`${id}.ts`, `${id}.tsx`, id, path.join(id, 'index.ts'), path.join(id, 'index.tsx')]) {
    const file = path.join(base, candidate);
    if (isFile(file)) return file;
  }
  return null;
}

export default defineConfig({
  ...desktop,
  root: desktopRoot,
  resolve: {
    ...desktop.resolve,
    alias: [
      { find: /^@\/(.*)$/, replacement: '$1', customResolver: (id: string, importer?: string) => resolveAt(importer, id) },
      ...Object.entries(baseAlias).filter(([find]) => find !== '@').map(([find, replacement]) => ({ find, replacement })),
    ],
  },
  test: {
    ...desktop.test,
    projects: undefined,
    include: ['src/test/transfer-baseline/transferBaseline.bench.ts'],
    exclude: [],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 1_500_000,
    hookTimeout: 60_000,
  },
});
