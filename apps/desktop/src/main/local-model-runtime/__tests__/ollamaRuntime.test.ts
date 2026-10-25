import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { probeOllamaStatus, startOfficialOllamaApp } from '../ollamaRuntime.js';
import { OllamaHttpError } from '../ollamaClient.js';

const WIN_LOCAL = 'C:\\Users\\dash\\AppData\\Local';
const WIN_OFFICIAL = path.join(WIN_LOCAL, 'Programs', 'Ollama', 'ollama.exe');

describe('ollamaRuntime', () => {
  // Native Mac ARM acceptance: Ollama binds its socket before its first GPU
  // discovery completes. Its own bootstrap budget exceeds our old 15s limit.
  it('keeps a headless first start pending through native GPU discovery', async () => {
    let now = 0;
    const spawnSidecar = vi.fn();
    const status = await startOfficialOllamaApp({ platform: 'darwin', arch: 'arm64', headless: true,
      installedBinary: () => '/fixture/ollama', spawnSidecar,
      now: () => now, sleep: async ms => { now += ms; },
      fetchImpl: async () => {
        if (now < 35_000) throw new OllamaHttpError('timeout', 'GPU discovery pending');
        return new Response(JSON.stringify({ version: '0.40.10' }));
      },
    });
    expect(status.kind).toBe('ready');
    expect(spawnSidecar).toHaveBeenCalledTimes(1);
  });
  // Behavior: terminal hosts must never launch a desktop app, including macOS
  // where an official application is installed. All supported OSes use serve.
  it.each(['darwin', 'linux', 'win32'] as const)('starts only the server binary on a headless %s host', async platform => {
    const openApp = vi.fn(); let ready = false;
    const spawnSidecar = vi.fn(() => { ready = true; });
    const status = await startOfficialOllamaApp({ platform, arch: 'arm64', headless: true,
      installedBinary: () => '/fixture/ollama', appExists: () => true, openApp, spawnSidecar,
      sleep: async () => {}, fetchImpl: async () => {
        if (!ready) throw new OllamaHttpError('refused', 'down');
        return new Response(JSON.stringify({version: '0.40.10'}));
      },
    });
    expect(status.kind).toBe('ready'); expect(spawnSidecar).toHaveBeenCalledWith('/fixture/ollama');
    expect(openApp).not.toHaveBeenCalled();
  });

  it('maps connection refused + missing app to absent', async () => {
    const status = await probeOllamaStatus({
      platform: 'darwin',
      appExists: () => false,
      fetchImpl: async () => {
        throw new OllamaHttpError('refused', 'down');
      },
    });
    expect(status).toMatchObject({ kind: 'absent', appInstalled: false });
  });

  it('maps connection refused + installed app to stopped', async () => {
    const status = await probeOllamaStatus({
      platform: 'darwin',
      appExists: () => true,
      fetchImpl: async () => {
        throw new OllamaHttpError('refused', 'down');
      },
    });
    expect(status).toMatchObject({ kind: 'stopped', appInstalled: true });
  });

  it('starts a Cindy sidecar when the official app is missing', async () => {
    const spawnSidecar = vi.fn();
    let ready = false;
    const status = await startOfficialOllamaApp({
      platform: 'darwin',
      userDataDir: '/tmp/cindy-ollama-sidecar',
      appExists: () => false,
      spawnSidecar,
      fetchImpl: async () => {
        if (!ready) {
          ready = true;
          throw new OllamaHttpError('refused', 'down');
        }
        return new Response(JSON.stringify({ version: '0.32.14' }));
      },
    });
    expect(spawnSidecar).not.toHaveBeenCalled();
    expect(status.kind).toBe('absent');
  });

  it('maps connection refused + missing windows app to absent and installable', async () => {
    const status = await probeOllamaStatus({
      platform: 'win32',
      arch: 'x64',
      env: { LOCALAPPDATA: WIN_LOCAL },
      appExists: () => false,
      fetchImpl: async () => {
        throw new OllamaHttpError('refused', 'down');
      },
    });
    expect(status).toMatchObject({ kind: 'absent', appInstalled: false, canInstallRuntime: true });
  });

  it('maps connection refused + official windows install to stopped', async () => {
    const status = await probeOllamaStatus({
      platform: 'win32',
      arch: 'x64',
      env: { LOCALAPPDATA: WIN_LOCAL },
      appExists: (filePath) => filePath === WIN_OFFICIAL,
      fetchImpl: async () => {
        throw new OllamaHttpError('refused', 'down');
      },
    });
    expect(status).toMatchObject({
      kind: 'stopped',
      appInstalled: true,
      canInstallRuntime: false,
    });
  });

  it('starts official windows ollama.exe when present', async () => {
    const spawnSidecar = vi.fn();
    let ready = false;
    const status = await startOfficialOllamaApp({
      platform: 'win32',
      arch: 'x64',
      env: { LOCALAPPDATA: WIN_LOCAL },
      appExists: (filePath) => filePath === WIN_OFFICIAL,
      spawnSidecar,
      fetchImpl: async () => {
        if (!ready) {
          ready = true;
          throw new OllamaHttpError('refused', 'down');
        }
        return new Response(JSON.stringify({ version: '0.32.14' }));
      },
    });
    expect(spawnSidecar).toHaveBeenCalledWith(WIN_OFFICIAL);
    expect(status.kind).toBe('ready');
  });

  it('does not spawn when the port is already a non-Ollama service', async () => {
    const openApp = vi.fn();
    const status = await startOfficialOllamaApp({
      platform: 'darwin',
      appExists: () => true,
      openApp,
      fetchImpl: async () => {
        throw new OllamaHttpError('conflict', 'busy');
      },
    });
    expect(openApp).not.toHaveBeenCalled();
    expect(status.kind).toBe('port-conflict');
  });

  it('aborts start polling when the install signal fires', async () => {
    const abort = new AbortController();
    const pending = startOfficialOllamaApp({
      platform: 'darwin',
      appExists: () => true,
      openApp: async () => undefined,
      signal: abort.signal,
      sleep: () => new Promise(() => undefined),
      fetchImpl: async () => {
        throw new OllamaHttpError('refused', 'down');
      },
    });
    abort.abort();
    await expect(pending).rejects.toThrow('aborted');
  });
});
