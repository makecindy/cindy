/** Electron wiring for bounded asynchronous main-process directory probes. */

import { app } from 'electron';
import path from 'node:path';

import { createLogger } from '../logger.js';
import { MainProcessWorkdirProbeClient } from './MainProcessWorkdirProbeClient.js';
import type { WorkdirProbeRequest } from './protocol.js';

const log = createLogger('workdir-diagnostics');

export const workdirProbeHostClient = new MainProcessWorkdirProbeClient({ log });

/** Bounded filesystem identity probe for local cwd recovery; never expose paths to a controller. */
async function directoryOperation(dir: string, kind: WorkdirProbeRequest['kind']) {
  const result = await workdirProbeHostClient.probe(dir, path.resolve(dir), 5_000, kind);
  if (!result.ok)
    throw Object.assign(new Error('Working directory probe failed'), { code: result.code });
  return result;
}

export async function statWorkingDirectory(
  dir: string,
): Promise<{ isDirectory(): boolean; dev?: number }> {
  const result = await directoryOperation(dir, 'probe');
  return { isDirectory: () => result.isDirectory, dev: result.device };
}

export async function mkdirWorkingDirectory(dir: string): Promise<void> {
  await directoryOperation(dir, 'mkdir');
}

export async function realpathWorkingDirectory(dir: string): Promise<string> {
  const result = await directoryOperation(dir, 'realpath');
  if (typeof result.path !== 'string') throw new Error('Invalid resolved directory');
  return result.path;
}

export async function findSimilarWorkingDirectory(dir: string): Promise<string | null> {
  return (await directoryOperation(dir, 'similar')).path ?? null;
}

if (typeof app.once === 'function') {
  app.once('before-quit', () => {
    workdirProbeHostClient.dispose();
  });
}
