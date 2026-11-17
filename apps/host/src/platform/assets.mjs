import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { hostRuntimeLayout } from '../runtime-layout.mjs';

/** A trusted OS-facts worker; it has no task store, renderer or listening port. */
export async function preparePowerWorker() {
  const layout = hostRuntimeLayout();
  if (layout.packaged) {
    if (!layout.electronBinary) throw new Error('PLATFORM_MONITOR_UNAVAILABLE');
    return { binary: layout.electronBinary, script: layout.powerWorker, close: async () => {} };
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-host-platform-'));
  try {
    const { build } = await import('esbuild');
    const script = path.join(root, 'power-worker.cjs');
    await build({ entryPoints: [fileURLToPath(new URL('../../../desktop/src/main/host-platform/power-worker.desktop.ts', import.meta.url))],
      outfile: script, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] });
    const binary = createRequire(new URL('../../../desktop/package.json', import.meta.url))('electron');
    return { binary, script, close: () => fs.rm(root, { recursive: true, force: true }) };
  } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
}
