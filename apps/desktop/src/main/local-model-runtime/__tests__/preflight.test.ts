import { beforeEach, describe, expect, it, vi } from 'vitest';

const startOfficialOllamaApp = vi.fn();
const getCustomProvider = vi.fn();
const startLlamaCpp = vi.fn();
const getManagedLlamaCppService = vi.fn<(...args: unknown[]) => { start: typeof startLlamaCpp }>(
  () => ({ start: startLlamaCpp }),
);

vi.mock('../llamaCppService.js', () => ({
  getManagedLlamaCppService: (...args: unknown[]) => getManagedLlamaCppService(...args),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cindy-user-data-fallback' },
}));

vi.mock('../../maker-host/custom-provider-store.js', () => ({
  getCustomProvider: (...args: unknown[]) => getCustomProvider(...args),
}));

vi.mock('../ollamaRuntime.js', () => ({
  startOfficialOllamaApp: (...args: unknown[]) => startOfficialOllamaApp(...args),
}));

import { MANAGED_OLLAMA_PROVIDER_ID } from '../../../shared/localModelRuntime.js';
import { buildEmptyManagedOllamaProvider } from '../managedOllamaProvider.js';
import { ensureManagedOllamaReadyForSession } from '../preflight.js';
import { MANAGED_LLAMACPP_PROVIDER_ID } from '../../../shared/llamaCpp.js';
import { buildManagedLlamaCppProvider } from '../managedLlamaCppProvider.js';

describe('ensureManagedOllamaReadyForSession', () => {
  beforeEach(() => {
    startOfficialOllamaApp.mockReset();
    getCustomProvider.mockReset();
    startLlamaCpp.mockReset();
    getManagedLlamaCppService.mockClear();
    startOfficialOllamaApp.mockResolvedValue({ kind: 'ready', runtime: 'ollama' });
    getCustomProvider.mockResolvedValue(buildEmptyManagedOllamaProvider());
  });

  it('starts managed llama.cpp for a local session', async () => {
    getCustomProvider.mockResolvedValue(buildManagedLlamaCppProvider([]));
    await ensureManagedOllamaReadyForSession({
      providerId: MANAGED_LLAMACPP_PROVIDER_ID,
      userDataDir: '/tmp/llamacpp-session',
    });
    expect(getManagedLlamaCppService).toHaveBeenCalledWith('/tmp/llamacpp-session');
    expect(startLlamaCpp).toHaveBeenCalledOnce();
    expect(startOfficialOllamaApp).not.toHaveBeenCalled();
  });

  it('does not start local llama.cpp for SSH sessions or changed endpoints', async () => {
    await ensureManagedOllamaReadyForSession({
      providerId: MANAGED_LLAMACPP_PROVIDER_ID,
      remoteHostId: 'remote',
    });
    expect(getCustomProvider).not.toHaveBeenCalled();
    const config = buildManagedLlamaCppProvider([]);
    config.runtimes.pi!.baseUrl = 'http://example.com/v1';
    getCustomProvider.mockResolvedValue(config);
    await expect(
      ensureManagedOllamaReadyForSession({
        providerId: MANAGED_LLAMACPP_PROVIDER_ID,
      }),
    ).rejects.toThrow('LOCAL_LLAMACPP_NOT_READY');
    expect(startLlamaCpp).not.toHaveBeenCalled();
  });

  it('starts the sidecar with the caller userDataDir', async () => {
    await ensureManagedOllamaReadyForSession({
      providerId: MANAGED_OLLAMA_PROVIDER_ID,
      remoteHostId: null,
      userDataDir: '/tmp/cindy-sidecar-data',
    });
    expect(startOfficialOllamaApp).toHaveBeenCalledWith(
      expect.objectContaining({ userDataDir: '/tmp/cindy-sidecar-data' }),
    );
  });

  it('falls back to Electron userData when the caller omits it', async () => {
    await ensureManagedOllamaReadyForSession({
      providerId: MANAGED_OLLAMA_PROVIDER_ID,
      remoteHostId: null,
    });
    expect(startOfficialOllamaApp).toHaveBeenCalledWith(
      expect.objectContaining({ userDataDir: '/tmp/cindy-user-data-fallback' }),
    );
  });
});
