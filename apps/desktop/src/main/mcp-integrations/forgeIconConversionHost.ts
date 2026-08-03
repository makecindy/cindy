/** Electron wiring for the cancellable Forge icon conversion utility process. */

import os from 'node:os';
import path from 'node:path';
import { utilityProcess } from 'electron';

import type { ForgeIconConversionChildLike } from './forgeIconConversion.js';

export function forkForgeIconConversionHost(): ForgeIconConversionChildLike {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
  ] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return utilityProcess.fork(path.join(__dirname, 'forgeIconConversionProcess.js'), [], {
    serviceName: 'cindy-forge-icon-converter',
    env,
    cwd: os.tmpdir(),
  });
}
