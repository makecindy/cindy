import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearAllSessionProviders,
  clearSessionProvider,
  getSessionProvider,
  hydrateSessionProvider,
  setSessionProvider,
} from '../../maker-host/session-provider-store.js';
import { hydrateProviderIdBeforeSessionStart, persistAndHydrateSessionProvider } from '../sessionProviderBootstrap.js';

const TEST_SESSION_ID = 'session-provider-bootstrap-test';

afterEach(() => {
  clearSessionProvider(TEST_SESSION_ID);
});

// Unit regression: unlike the post-create hydrate tests, this exercises the
// startup boundary. An unavailable saved source must not become a default route.
describe('provider identity before startup', () => {
  it('rejects a failed saved-provider read rather than continuing to default routing', async () => {
    const options = { id: TEST_SESSION_ID };
    await expect(hydrateProviderIdBeforeSessionStart(options, async () => {
      throw new Error('database unavailable');
    })).rejects.toThrow('database unavailable');
    expect(options).toEqual({ id: TEST_SESSION_ID });
  });

  it.each(['xd', null, undefined])('preserves persisted provider %s including missing rows', async providerId => {
    const options: { id: string; providerId?: string | null } = { id: TEST_SESSION_ID };
    await hydrateProviderIdBeforeSessionStart(options, async () => providerId);
    expect(options.providerId).toBe(providerId);
    expect(Object.hasOwn(options, 'providerId')).toBe(providerId !== undefined);
  });

  it.each(['xd', null])('keeps an explicit startup choice %s without consulting stale storage', async providerId => {
    const options = { id: TEST_SESSION_ID, providerId };
    const read = vi.fn(async () => 'openai');
    await hydrateProviderIdBeforeSessionStart(options, read);
    expect(options.providerId).toBe(providerId);
    expect(read).not.toHaveBeenCalled();
  });
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

  it('clears every owner-scoped provider route at an account boundary', () => {
    setSessionProvider(TEST_SESSION_ID, 'anthropic');
    setSessionProvider('session-provider-bootstrap-other', 'openai');

    clearAllSessionProviders();

    expect(getSessionProvider(TEST_SESSION_ID)).toBeNull();
    expect(getSessionProvider('session-provider-bootstrap-other')).toBeNull();
  });
});
