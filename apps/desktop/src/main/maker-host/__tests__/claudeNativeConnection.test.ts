import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  available: true,
  bind: vi.fn(),
  unbind: vi.fn(),
  presentation: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('../claude-credentials-store.js', () => ({
  hasClaudeAiOAuthUnbound: () => h.available,
  readClaudeAiOAuth: () => null,
  writeClaudeAiOAuth: h.write,
  clearClaudeAiOAuth: h.clear,
}));
vi.mock('../nativeProviderAuthBinding.js', () => ({
  bindNativeProviderAuth: h.bind,
  unbindNativeProviderAuth: h.unbind,
}));
vi.mock('../provider-presentation-store.js', () => ({ setProviderPresentation: h.presentation }));
import { disconnectClaudeAiOAuth, reconnectClaudeAiOAuth } from '../claude-oauth-refresh.js';
beforeEach(() => {
  vi.clearAllMocks();
  h.available = true;
});
it('disconnect and reconnect only change the Cindy binding, never native credentials', () => {
  disconnectClaudeAiOAuth();
  expect(h.unbind).toHaveBeenCalledWith('anthropic', { revoked: true });
  expect(reconnectClaudeAiOAuth()).toBe(true);
  expect(h.bind).toHaveBeenCalledWith('anthropic', { sharedSystem: true });
  expect(h.presentation).toHaveBeenCalledWith('anthropic', { removed: false });
  expect(h.write).not.toHaveBeenCalled();
  expect(h.clear).not.toHaveBeenCalled();
});
it('cannot attach a native source with no credentials', () => {
  h.available = false;
  expect(reconnectClaudeAiOAuth()).toBe(false);
  expect(h.bind).not.toHaveBeenCalled();
});
it('revokes the Cindy binding if restoring the entry fails', () => {
  h.presentation.mockImplementationOnce(() => {
    throw new Error('disk full');
  });
  expect(() => reconnectClaudeAiOAuth()).toThrow('disk full');
  expect(h.unbind).toHaveBeenCalledWith('anthropic', { revoked: true });
  expect(h.write).not.toHaveBeenCalled();
  expect(h.clear).not.toHaveBeenCalled();
});
