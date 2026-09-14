import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { createLogger } from '../logger.js';
import {
  MAC_OLLAMA_APP_PATH,
  MAC_OPEN_BIN,
  type LocalRuntimeStatus,
} from '../../shared/localModelRuntime.js';
import { fetchOllamaVersion, OllamaHttpError, type OllamaFetch } from './ollamaClient.js';
import { supportsManagedOllamaInstall } from './ollamaRelease.js';
import { findInstalledSidecarBinary, spawnManagedSidecar } from './ollamaSidecar.js';

const execFileAsync = promisify(execFile);
const log = createLogger('local-model-runtime');

export const OLLAMA_START_TIMEOUT_MS = 15_000;
export const OLLAMA_START_POLL_MS = 400;

export interface OllamaRuntimeDeps {
  platform: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  fetchImpl: OllamaFetch;
  userDataDir?: string;
  env?: NodeJS.ProcessEnv;
  appExists?: (path: string) => boolean;
  openApp?: () => Promise<void>;
  spawnSidecar?: (binary: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function sleepUntilAborted(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) throw new Error('aborted');
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      sleep(ms),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function macOllamaAppInstalled(
  platform: NodeJS.Platform,
  appExists: (path: string) => boolean = existsSync,
): boolean {
  return platform === 'darwin' && appExists(MAC_OLLAMA_APP_PATH);
}

export function windowsOfficialOllamaBinaries(env: NodeJS.ProcessEnv = process.env): string[] {
  const binaries: string[] = [];
  if (env.LOCALAPPDATA) {
    binaries.push(path.join(env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
  }
  if (env.ProgramFiles) {
    binaries.push(path.join(env.ProgramFiles, 'Ollama', 'ollama.exe'));
  }
  return binaries;
}

export function windowsOfficialOllamaBinary(
  env: NodeJS.ProcessEnv = process.env,
  appExists: (filePath: string) => boolean = existsSync,
): string | null {
  return windowsOfficialOllamaBinaries(env).find((filePath) => appExists(filePath)) ?? null;
}

function officialRuntimeInstalled(deps: OllamaRuntimeDeps): boolean {
  const appExists = deps.appExists ?? existsSync;
  if (macOllamaAppInstalled(deps.platform, appExists)) return true;
  if (deps.platform === 'win32') {
    return windowsOfficialOllamaBinary(deps.env ?? process.env, appExists) !== null;
  }
  return false;
}

function canInstall(deps: OllamaRuntimeDeps): boolean {
  return (
    supportsManagedOllamaInstall(deps.platform, deps.arch ?? process.arch) &&
    !officialRuntimeInstalled(deps)
  );
}

export async function defaultOpenOfficialOllamaApp(): Promise<void> {
  await execFileAsync(MAC_OPEN_BIN, ['-g', '-j', MAC_OLLAMA_APP_PATH, '--args', 'hidden'], {
    timeout: 5_000,
  });
}

function localRuntimeAvailable(deps: OllamaRuntimeDeps): boolean {
  if (officialRuntimeInstalled(deps)) return true;
  return Boolean(deps.userDataDir && findInstalledSidecarBinary(deps.userDataDir));
}

export async function probeOllamaStatus(deps: OllamaRuntimeDeps): Promise<LocalRuntimeStatus> {
  const appInstalled = localRuntimeAvailable(deps);
  const canInstallRuntime = canInstall(deps);
  try {
    const info = await fetchOllamaVersion(deps.fetchImpl);
    return {
      runtime: 'ollama',
      kind: 'ready',
      appInstalled,
      canInstallRuntime,
      version: info.version,
    };
  } catch (error) {
    if (error instanceof OllamaHttpError) {
      if (error.kind === 'conflict') {
        return {
          runtime: 'ollama',
          kind: 'port-conflict',
          appInstalled,
          canInstallRuntime,
          message: error.message,
        };
      }
      if (error.kind === 'timeout') {
        return {
          runtime: 'ollama',
          kind: appInstalled ? 'stopped' : 'absent',
          appInstalled,
          canInstallRuntime,
          message: error.message,
        };
      }
      return {
        runtime: 'ollama',
        kind: appInstalled ? 'stopped' : 'absent',
        appInstalled,
        canInstallRuntime,
      };
    }
    log.warn('ollama probe failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      runtime: 'ollama',
      kind: 'error',
      appInstalled,
      canInstallRuntime,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function startOfficialOllamaApp(deps: OllamaRuntimeDeps): Promise<LocalRuntimeStatus> {
  const current = await probeOllamaStatus(deps);
  if (
    current.kind === 'ready' ||
    current.kind === 'port-conflict' ||
    current.kind === 'incompatible'
  ) {
    return current;
  }
  if (macOllamaAppInstalled(deps.platform, deps.appExists ?? existsSync)) {
    const openApp = deps.openApp ?? defaultOpenOfficialOllamaApp;
    try {
      await openApp();
    } catch (error) {
      return {
        runtime: 'ollama',
        kind: 'error',
        appInstalled: true,
        canInstallRuntime: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    const officialWindows =
      deps.platform === 'win32'
        ? windowsOfficialOllamaBinary(deps.env ?? process.env, deps.appExists ?? existsSync)
        : null;
    const binary =
      officialWindows ?? (deps.userDataDir ? findInstalledSidecarBinary(deps.userDataDir) : null);
    if (!binary) {
      return {
        runtime: 'ollama',
        kind: 'absent',
        appInstalled: false,
        canInstallRuntime: canInstall(deps),
      };
    }
    try {
      (deps.spawnSidecar ?? spawnManagedSidecar)(binary);
    } catch (error) {
      return {
        runtime: 'ollama',
        kind: 'error',
        appInstalled: true,
        canInstallRuntime: canInstall(deps),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const deadline = now() + OLLAMA_START_TIMEOUT_MS;
  while (now() < deadline) {
    if (deps.signal?.aborted) throw new Error('aborted');
    await sleepUntilAborted(sleep, OLLAMA_START_POLL_MS, deps.signal);
    if (deps.signal?.aborted) throw new Error('aborted');
    const next = await probeOllamaStatus(deps);
    if (next.kind === 'ready' || next.kind === 'port-conflict') return next;
  }
  return {
    runtime: 'ollama',
    kind: 'stopped',
    appInstalled: true,
    message: 'Ollama did not become ready in time',
  };
}
