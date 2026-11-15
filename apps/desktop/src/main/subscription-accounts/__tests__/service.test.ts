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
  migrate: vi.fn(),
  place: vi.fn(),
}));
vi.mock('../runtime.js', () => ({ runSubscriptionAccountCommand: h.run }));
vi.mock('../store.js', () => ({ readAccountBinding: h.binding, migrateLegacyCodexAccounts: h.migrate,
  readLegacyCodexAccountId: () => 'imported' }));
vi.mock('../placement.js', () => ({ placeSubscriptionAccount: h.place,
  resolveSubscriptionPoolProvider: (id: string) => id === 'anthropic' || id === 'openai' ? { kind: id, providerId: id } : null }));
vi.mock('../../maker-host/active-catalog.js', () => ({ getActiveCatalog: () => ({ providers: [
  { id: 'openai-old', source: 'user', auth: { native: 'codex' } },
] }) }));
vi.mock('../../maker-host/model-disable-store.js', () => ({ readModelDisableOverrides: () => ({}) }));
vi.mock('../../maker-host/nativeProviderAuthBinding.js', () => ({
  isNativeProviderAuthBound: () => true, isNativeProviderAuthSharedSystemCredential: () => true,
}));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({ publishSubscriptionPoolProviders: vi.fn() }));
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
  h.migrate.mockReset().mockResolvedValue(undefined);
  h.place.mockReset().mockResolvedValue(undefined);
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

// PR #10405, unit: registration awaited migration before changing account placement without
// rechecking the signed-in owner; previous tests covered only the read-only metadata lookup.
it('stops legacy placement after the owner changes during registration', async () => {
  h.migrate.mockImplementation(async () => { h.owner = 'owner-b'; });
  await expect(executeSubscriptionAccountCommand({ action: 'merge', providerId: 'openai-old', target: 'openai' }))
    .rejects.toThrow('Subscription accounts changed');
  expect(h.place).not.toHaveBeenCalled();
  expect(h.run).not.toHaveBeenCalled();
});
