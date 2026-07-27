import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearSessionProvider,
  getSessionProvider,
  hydrateSessionProvider,
  setSessionProvider,
} from '../../maker-host/session-provider-store.js';
import { persistAndHydrateSessionProvider } from '../sessionProviderBootstrap.js';

const TEST_SESSION_ID = 'session-provider-bootstrap-test';

afterEach(() => {
  clearSessionProvider(TEST_SESSION_ID);
});

describe('persistAndHydrateSessionProvider', () => {
  it('persists explicit providerId=null and hydrates the cleared route', async () => {
    let storedProviderId: string | null = 'anthropic';
    const hydrateSessionProvider = vi.fn();

    await persistAndHydrateSessionProvider({
      sessionId: 'session-1',
      providerId: null,
      updateProviderId: vi.fn(async (_sessionId, providerId) => {
        storedProviderId = providerId;
      }),
      readProviderId: vi.fn(async () => storedProviderId),
      hydrateSessionProvider,
    });

    expect(storedProviderId).toBeNull();
    expect(hydrateSessionProvider).toHaveBeenCalledWith('session-1', null);
  });

  it('leaves DB unchanged for providerId=undefined but still hydrates persisted value', async () => {
    const updateProviderId = vi.fn(async () => {});
    const hydrateSessionProvider = vi.fn();

    await persistAndHydrateSessionProvider({
      sessionId: 'session-1',
      providerId: undefined,
      updateProviderId,
      readProviderId: vi.fn(async () => 'openrouter'),
      hydrateSessionProvider,
    });

    expect(updateProviderId).not.toHaveBeenCalled();
    expect(hydrateSessionProvider).toHaveBeenCalledWith('session-1', 'openrouter');
  });

  it('does not treat a missing DB row as an explicit provider clear', async () => {
    setSessionProvider(TEST_SESSION_ID, 'anthropic');

    await persistAndHydrateSessionProvider({
      sessionId: TEST_SESSION_ID,
      providerId: undefined,
      updateProviderId: vi.fn(async () => {}),
      readProviderId: vi.fn(async () => undefined),
      hydrateSessionProvider,
    });

    expect(getSessionProvider(TEST_SESSION_ID)).toBe('anthropic');
  });

  it('does not overwrite a runtime provider selected while the DB read is in flight', async () => {
    let resolveRead!: (providerId: string | null) => void;
    const persistedProviderId = new Promise<string | null>((resolve) => {
      resolveRead = resolve;
    });
    const readProviderId = vi.fn(async () => persistedProviderId);
    const hydration = persistAndHydrateSessionProvider({
      sessionId: TEST_SESSION_ID,
      providerId: undefined,
      updateProviderId: vi.fn(async () => {}),
      readProviderId,
      hydrateSessionProvider,
    });
    expect(readProviderId).toHaveBeenCalledWith(TEST_SESSION_ID);

    setSessionProvider(TEST_SESSION_ID, 'anthropic');
    resolveRead('openai');
    await hydration;

    expect(getSessionProvider(TEST_SESSION_ID)).toBe('anthropic');
  });
});
