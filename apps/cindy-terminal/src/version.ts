import { readCindyBuildVersion, readCindyBuildRegion } from '../scripts/build-version.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export let RUNTIME_DIRECTORY=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist');
let childNode: string | undefined;

/** Explicit trusted bootstrap configuration, never an environment/CLI switch
 * that lets a packaged graphical host load arbitrary JavaScript. */
export function configureTerminalDistribution(paths: { directory: string; node: string }): void {
  if (childNode || !path.isAbsolute(paths.directory) || !path.isAbsolute(paths.node)) throw new Error('TERMINAL_RUNTIME_PATHS_INVALID');
  RUNTIME_DIRECTORY = paths.directory;
  childNode = paths.node;
}

export function terminalNodeExecutable(): string {
  if (childNode) return childNode;
  if (process.versions.electron) throw new Error('TERMINAL_NODE_NOT_CONFIGURED');
  return process.execPath;
}

declare const __CINDY_APP_VERSION__: string;
declare const __CINDY_APP_REGION__: 'global' | 'cn';

export const REGION: 'global' | 'cn' = typeof __CINDY_APP_REGION__ === 'string'
  ? __CINDY_APP_REGION__
  : readCindyBuildRegion();

// Packaged servers keep their build identity even when the launch environment
// changes; development runs resolve the same identity directly from the source.
export const VERSION = typeof __CINDY_APP_VERSION__ === 'string'
  ? __CINDY_APP_VERSION__
  : readCindyBuildVersion();
