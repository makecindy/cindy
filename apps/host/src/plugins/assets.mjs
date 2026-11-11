import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { hostRuntimeLayout } from '../runtime-layout.mjs';

/** Installed artifacts never build code. Source runs compile only owned workers
 * into an isolated temporary directory, removed after all children have exited. */
export async function prepareHostPluginAssets() {
  const layout = hostRuntimeLayout();
  if (layout.packaged) return {
    nodeWorker: layout.nodeWorker, libraryWorker: layout.libraryWorker,
    bridgeSource: await fs.readFile(layout.pluginBridge, 'utf8'),
    executablePath: layout.chromiumExecutable,
    close: async () => {},
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-host-workers-'));
  try {
    const { build } = await import('esbuild');
    const nodeWorker = path.join(root, 'node-worker.cjs');
    const libraryWorker = path.join(root, 'library-worker.mjs');
    for (const [source, outfile] of [
      [new URL('./node-worker.ts', import.meta.url), nodeWorker],
      [new URL('../../../desktop/src/main/cindy-brain/libraryDbWorker.ts', import.meta.url), libraryWorker],
    ]) await build({ entryPoints: [fileURLToPath(source)], outfile, bundle: true, platform: 'node', format: outfile.endsWith('.mjs') ? 'esm' : 'cjs', target: 'node22' });
    const bridge = await build({ entryPoints: [fileURLToPath(new URL('../../../desktop/src/shared/ghostPageBridge.ts', import.meta.url))],
      write: false, bundle: true, platform: 'browser', format: 'iife', globalName: 'CindyPluginBridge' });
    return { nodeWorker, libraryWorker, bridgeSource: bridge.outputFiles[0].text,
      executablePath: undefined, close: () => fs.rm(root, { recursive: true, force: true }) };
  } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
}
