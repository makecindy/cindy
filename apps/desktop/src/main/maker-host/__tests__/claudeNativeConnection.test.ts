import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  available: true,
  token: 'native-test-token',
  rejected: null as string | null,
  bind: vi.fn(),
  unbind: vi.fn(),
  presentation: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('../claude-credentials-store.js', async (original) => ({
  ...(await original<typeof import('../claude-credentials-store.js')>()),
  readClaudeAiOAuthUnbound: () => h.available ? { accessToken: h.token } : null,
  readClaudeAiOAuth: () => null,
  writeClaudeAiOAuth: h.write,
  clearClaudeAiOAuth: h.clear,
}));
vi.mock('../nativeProviderAuthBinding.js', () => ({
  bindNativeProviderAuth: h.bind,
  unbindNativeProviderAuth: h.unbind,
  isNativeProviderCredentialRejected: (_provider: string, digest: string) => digest === h.rejected,
}));
vi.mock('../override-settings-file.js', () => ({ createOverrideSettingsFile: () => ({
  invalidateIfChanged: vi.fn(), read: () => ({}), writePatch: h.presentation,
}) }));
import { claudeOAuthCredentialDigest, disconnectClaudeAiOAuth, reconnectClaudeAiOAuth } from '../claude-oauth-refresh.js';
beforeEach(() => {
  vi.clearAllMocks();
  h.available = true;
  h.token = 'native-test-token';
  h.rejected = null;
});
it('rejects the revoked credential after disconnect but allows changed native credentials', () => {
  h.rejected = claudeOAuthCredentialDigest({ accessToken: h.token });
  disconnectClaudeAiOAuth();
  expect(reconnectClaudeAiOAuth()).toBe(false);
  expect(h.bind).not.toHaveBeenCalled();
  h.token = 'different-account-token';
  expect(reconnectClaudeAiOAuth()).toBe(true);
  expect(h.write).not.toHaveBeenCalled();
  expect(h.clear).not.toHaveBeenCalled();
});
it('disconnect and reconnect only change the Cindy binding, never native credentials', () => {
  disconnectClaudeAiOAuth();
  expect(h.unbind).toHaveBeenCalledWith('anthropic', { revoked: true });
  expect(reconnectClaudeAiOAuth()).toBe(true);
  expect(h.bind).toHaveBeenCalledWith('anthropic', { sharedSystem: true });
  expect(h.presentation).toHaveBeenCalledWith({ providers: { anthropic: { removed: false } } });
  expect(h.write).not.toHaveBeenCalled();
  expect(h.clear).not.toHaveBeenCalled();
});
it('cannot attach a native source with no credentials', () => {
  h.available = false;
  expect(reconnectClaudeAiOAuth()).toBe(false);
  expect(h.bind).not.toHaveBeenCalled();
});
it('preserves successful authentication if restoring the entry fails', () => {
  h.presentation.mockImplementationOnce(() => {
    throw new Error('disk full');
  });
  expect(reconnectClaudeAiOAuth()).toBe(true);
  expect(h.unbind).not.toHaveBeenCalled();
  expect(h.write).not.toHaveBeenCalled();
  expect(h.clear).not.toHaveBeenCalled();
});
