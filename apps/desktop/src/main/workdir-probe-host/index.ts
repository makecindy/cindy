/** Bounded asynchronous directory probes shared by both process launchers. */

import path from 'node:path';

import { createLogger } from '../logger.js';
import { MainProcessWorkdirProbeClient } from './MainProcessWorkdirProbeClient.js';
import type { WorkdirProbeRequest } from './protocol.js';

const log = createLogger('workdir-diagnostics');

export const workdirProbeHostClient = new MainProcessWorkdirProbeClient({ log });
// Alias scans can touch projects outside the active workspace. Their stalled
// filesystem calls must not hold the foreground directory probe slots.
const automationAliasProbeClient = new MainProcessWorkdirProbeClient({
  log,
  maxInFlight: 2,
  maxQueued: 8,
});

export function disposeWorkdirProbes(): void {
  workdirProbeHostClient.dispose();
  automationAliasProbeClient.dispose();
}

/** Bounded filesystem identity probe for local cwd recovery; never expose paths to a controller. */
async function directoryOperation(
  dir: string,
  kind: WorkdirProbeRequest['kind'],
  isCurrent?: () => boolean,
  client = workdirProbeHostClient,
) {
  const result = await client.probe(dir, path.resolve(dir), 5_000, kind, isCurrent);
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

export async function mkdirWorkingDirectory(
  dir: string,
  _options: { recursive: true },
  isCurrent: () => boolean,
): Promise<void> {
  await directoryOperation(dir, 'mkdir', isCurrent);
}

async function resolveDirectoryPath(dir: string, client: MainProcessWorkdirProbeClient): Promise<string> {
  const result = await directoryOperation(dir, 'realpath', undefined, client);
  if (typeof result.path !== 'string') throw new Error('Invalid resolved directory');
  return result.path;
}

export function realpathWorkingDirectory(dir: string): Promise<string> {
  return resolveDirectoryPath(dir, workdirProbeHostClient);
}

export function realpathAutomationAlias(dir: string): Promise<string> {
  return resolveDirectoryPath(dir, automationAliasProbeClient);
}

export async function findSimilarWorkingDirectory(dir: string): Promise<string | null> {
  return (await directoryOperation(dir, 'similar')).path ?? null;
}
