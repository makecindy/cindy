import { beforeEach, describe, expect, it, vi } from 'vitest';

const startOfficialOllamaApp = vi.fn();
const getCustomProvider = vi.fn();

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

describe('ensureManagedOllamaReadyForSession', () => {
  beforeEach(() => {
    startOfficialOllamaApp.mockReset();
    getCustomProvider.mockReset();
    startOfficialOllamaApp.mockResolvedValue({ kind: 'ready', runtime: 'ollama' });
    getCustomProvider.mockResolvedValue(buildEmptyManagedOllamaProvider());
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
