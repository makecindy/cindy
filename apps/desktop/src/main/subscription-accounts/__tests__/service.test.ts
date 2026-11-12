/** Unit: an old resumable task without task:<id> must not masquerade as a new
 * allocation. Runtime tests cover recorded bindings; these exercise the owner
 * command's legacy metadata lookup, native fallback and owner-switch fence. */
import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  owner: 'owner-a',
  run: vi.fn(),
  meta: vi.fn(),
  provider: vi.fn(),
  binding: vi.fn(),
}));
vi.mock('../runtime.js', () => ({ runSubscriptionAccountCommand: h.run }));
vi.mock('../store.js', () => ({ readAccountBinding: h.binding }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner,
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../maker-host/index.js', () => ({
  getMakerIfReady: () => ({ getSessionMeta: h.meta }),
  getMaker: vi.fn(),
  refreshSelectableModelsAndBroadcast: vi.fn(),
}));
vi.mock('../../maker-host/session-provider-store.js', () => ({ getSessionProvider: h.provider }));
vi.mock('../../maker-host/model-discovery/anthropic.js', () => ({
  requestAnthropicModelProbe: vi.fn(),
}));
import { executeSubscriptionAccountCommand } from '../service.js';

beforeEach(() => {
  h.owner = 'owner-a';
  h.run
    .mockReset()
    .mockImplementation(async () => ({ configured: true, boundAccountId: null, accounts: [] }));
  h.meta.mockReset().mockResolvedValue({ agentKind: 'claude-code', sdkSessionId: 'native-a' });
  h.provider.mockReset().mockReturnValue('anthropic');
  h.binding.mockReset().mockReturnValue(null);
});
const read = () =>
  executeSubscriptionAccountCommand({ action: 'read', providerId: 'anthropic', taskId: 'task-a' });

it('keeps an old resumable task unknown until its original account is known', async () => {
  expect((await read()).boundAccountId).toBeUndefined();
  h.binding.mockReturnValue({ accountId: 'original' });
  expect((await read()).boundAccountId).toBe('original');
  expect(h.binding).toHaveBeenLastCalledWith('native:native-a', 'anthropic');
});

it('previews a new provider without borrowing another provider native session', async () => {
  h.provider.mockReturnValue('openai');
  expect((await read()).boundAccountId).toBeNull();
  expect(h.binding).not.toHaveBeenCalled();
  h.provider.mockReturnValue('anthropic');
  h.meta.mockResolvedValue({ agentKind: 'claude-code' });
  expect((await read()).boundAccountId).toBeNull();
});

it('retains recorded task bindings without reinterpreting legacy metadata', async () => {
  h.run.mockResolvedValue({ configured: true, boundAccountId: 'paused-original', accounts: [] });
  expect((await read()).boundAccountId).toBe('paused-original');
  expect(h.meta).not.toHaveBeenCalled();
});

it('rejects an owner switch during the metadata lookup', async () => {
  h.meta.mockImplementation(async () => {
    h.owner = 'owner-b';
    return { sdkSessionId: 'native-a' };
  });
  await expect(read()).rejects.toThrow('Subscription accounts changed');
  expect(h.binding).not.toHaveBeenCalled();
});
