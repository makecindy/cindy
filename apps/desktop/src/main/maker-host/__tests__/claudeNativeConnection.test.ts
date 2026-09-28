import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  bound: true,
  loggedIn: true,
  bind: vi.fn(),
  unbind: vi.fn(),
  presentation: vi.fn(),
  readStatus: vi.fn(),
}));
vi.mock('../nativeProviderAuthBinding.js', () => ({
  bindNativeProviderAuth: h.bind,
  unbindNativeProviderAuth: h.unbind,
  isNativeProviderAuthBound: () => h.bound,
}));
vi.mock('../override-settings-file.js', () => ({ createOverrideSettingsFile: () => ({
  invalidateIfChanged: vi.fn(), read: () => ({}), updateAtomic: async (updater: (state: { value: object }) => object) => h.presentation(updater({ value: {} })),
}) }));
vi.mock('../claude-native-cli.js', () => ({
  readClaudeCliLoginStatus: h.readStatus,
}));
import {
  connectClaudeNativeLogin,
  disconnectClaudeNativeLogin,
  readClaudeNativeLogin,
} from '../claude-native-connection.js';
beforeEach(() => {
  vi.clearAllMocks();
  h.bound = true;
  h.loggedIn = true;
  h.readStatus.mockImplementation(async () => (h.loggedIn ? { loggedIn: true, email: 'user@example.com' } : { loggedIn: false }));
});
it('connect and disconnect only change the Cindy binding; the CLI login is never touched', async () => {
  await disconnectClaudeNativeLogin();
  expect(h.unbind).toHaveBeenCalledWith('anthropic', { revoked: true });
  connectClaudeNativeLogin();
  expect(h.bind).toHaveBeenCalledWith('anthropic', { sharedSystem: true });
  await vi.waitFor(() => expect(h.presentation).toHaveBeenCalledWith({ providers: { anthropic: { removed: false } } }));
});
it('reads the CLI login only when Cindy is allowed to use it', async () => {
  await expect(readClaudeNativeLogin({ maxAgeMs: 60_000 })).resolves.toEqual({ loggedIn: true, email: 'user@example.com' });
  expect(h.readStatus).toHaveBeenCalledWith({ maxAgeMs: 60_000 });
  h.loggedIn = false;
  await expect(readClaudeNativeLogin()).resolves.toBeNull();
  h.bound = false;
  h.loggedIn = true;
  h.readStatus.mockClear();
  await expect(readClaudeNativeLogin()).resolves.toBeNull();
  expect(h.readStatus).not.toHaveBeenCalled();
});
it('completes connect synchronously while auxiliary presentation persistence is blocked', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  h.presentation.mockReturnValueOnce(pending);
  connectClaudeNativeLogin();
  expect(h.bind).toHaveBeenCalledWith('anthropic', { sharedSystem: true });
  expect(h.unbind).not.toHaveBeenCalled();
  release();
  await pending;
});
it('keeps the connection if restoring the entry fails', async () => {
  h.presentation.mockImplementationOnce(() => {
    throw new Error('disk full');
  });
  expect(() => connectClaudeNativeLogin()).not.toThrow();
  expect(h.bind).toHaveBeenCalledWith('anthropic', { sharedSystem: true });
  expect(h.unbind).not.toHaveBeenCalled();
});
it('completes disconnect when display persistence fails', async () => {
  h.presentation.mockImplementationOnce(() => { throw new Error('disk full'); });
  await expect(disconnectClaudeNativeLogin()).resolves.toBeUndefined();
  expect(h.unbind).toHaveBeenCalledWith('anthropic', { revoked: true });
  expect(h.presentation).toHaveBeenCalled();
});
it('still reports failure when the binding cannot be revoked', async () => {
  h.unbind.mockImplementationOnce(() => { throw new Error('binding write failed'); });
  await expect(disconnectClaudeNativeLogin()).rejects.toThrow('binding write failed');
  expect(h.presentation).not.toHaveBeenCalled();
});
