/** Standard tier: owner-only account management, wire validation and path confinement.
 * Native process calls and metadata persistence are replaced; the production parser/path builder run unchanged.
 */
import path from 'node:path';
import { homedir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, arg: unknown) => Promise<unknown>>(),
  context: null as null | { sharedTask?: object },
  trusted: true,
  execute: vi.fn(),
  owner: 'owner-a',
  generation: 1,
  bindings: {} as Record<string, { providerId: 'anthropic' | 'openai'; accountId: string }>,
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, arg: unknown) => Promise<unknown>) =>
      h.handlers.set(name, handler),
  },
}));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: () => {
    if (!h.trusted) throw new Error('untrusted');
  },
}));
vi.mock('../../device-link/invoke-context.js', () => ({
  getDeviceLinkInvokeContext: () => h.context,
}));
vi.mock('../../device-link/index.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../device-link/dispatch.js', () => ({ setRemoteSubscriptionPoolQuotaReader: vi.fn() }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => `${h.owner}:${h.generation}`,
  getActiveAppSession: () => ({ dataOwnerId: h.owner }),
  ownerScopedUserDataPath: vi.fn(),
}));
vi.mock('../../maker-host/logger-adapter.js', () => ({ desktopMakerLogger: {} }));
vi.mock('../../maker-host/override-settings-file.js', () => ({
  createOverrideSettingsFile: () => ({ read: () => ({ bindings: h.bindings }) }),
}));
vi.mock('../service.js', () => ({ executeSubscriptionAccountCommand: h.execute }));
vi.mock('../runtime.js', () => ({
  onSubscriptionAccountsChanged: vi.fn(),
  readSubscriptionPoolUsage: vi.fn(async () => undefined),
  readLegacySubscriptionPoolUsage: vi.fn(async () => undefined),
  readSubscriptionSessionUsage: vi.fn(async () => undefined),
}));
import { registerSubscriptionAccountsIpc } from '../ipc.js';
import { accountDirectory, accountOwnerPrefix, readBoundClaudeConfigDir } from '../store.js';
import { SUBSCRIPTION_ACCOUNTS_CHANNEL } from '../../../shared/subscriptionAccounts.js';
registerSubscriptionAccountsIpc();
const invoke = (command: unknown) => h.handlers.get(SUBSCRIPTION_ACCOUNTS_CHANNEL)!({}, command);
beforeEach(() => {
  h.context = null;
  h.trusted = true;
  h.owner = 'owner-a';
  h.generation = 1;
  h.bindings = {};
  h.execute.mockReset().mockResolvedValue({ accounts: [] });
});
describe('subscription management boundary', () => {
  it('admits the trusted owner and paired owner remote context, never an untrusted frame or shared-task guest', async () => {
    const command = { action: 'read', providerId: 'anthropic' };
    await invoke(command);
    h.trusted = false;
    await expect(invoke(command)).rejects.toThrow('untrusted');
    h.context = {};
    await invoke(command);
    h.context = { sharedTask: {} };
    await expect(invoke(command)).rejects.toThrow('PERMISSION_DENIED');
    expect(h.execute).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid account paths, settings and login keys before any native operation', async () => {
    for (const command of [
      { action: 'login', accountId: '../credentials', loginKey: 'login' },
      { action: 'add', loginKey: '../callback' },
      { action: 'connect', target: '../credentials', loginKey: 'login' },
      { action: 'connect', target: 'new', loginKey: '../callback' },
      { action: 'connect', loginKey: 'login' },
      { action: 'configure', accountId: 'default', limit: 0 },
      { action: 'configure', paused: false },
      { action: 'configure', strategy: 'unknown' },
    ])
      await expect(invoke({ providerId: 'anthropic', ...command })).rejects.toThrow(
        'INVALID_PARAMS',
      );
    expect(h.execute).not.toHaveBeenCalled();
  });
  // The new intent must survive the real owner IPC parser. An old "add" fallback
  // could silently attach the detected default instead of opening another login.
  it.each(['anthropic', 'openai'])(
    'preserves explicit %s preview/default/new intent across owner IPC',
    async (providerId) => {
      for (const command of [
        { action: 'preview', providerId },
        { action: 'connect', target: 'default', providerId, loginKey: 'existing' },
        { action: 'connect', target: 'new', providerId, loginKey: 'another' },
      ]) {
        await expect(invoke(command)).resolves.toEqual({ accounts: [] });
        expect(h.execute).toHaveBeenLastCalledWith(command);
      }
    },
  );
  it('derives stable directories from the owner, refusing another owner’s account id', () => {
    const id = `cindy-${accountOwnerPrefix()}-12345678-1234-4123-8123-123456789abc`;
    const directory = accountDirectory('anthropic', id);
    h.bindings = {
      'anthropic:native:secondary': { providerId: 'anthropic', accountId: id },
      'anthropic:native:default': { providerId: 'anthropic', accountId: 'default' },
      'openai:native:codex': { providerId: 'openai', accountId: id },
    };
    expect(readBoundClaudeConfigDir('secondary')).toBe(directory);
    expect(readBoundClaudeConfigDir('default')).toBeUndefined();
    expect(readBoundClaudeConfigDir('unbound')).toBeUndefined();
    expect(readBoundClaudeConfigDir('codex')).toBeUndefined();
    expect(accountDirectory('anthropic', 'default')).toBe(path.join(homedir(), '.claude'));
    expect(accountDirectory('openai', 'default')).toBe(path.join(homedir(), '.codex'));
    expect(directory).toBe(path.join(homedir(), `.claude-${id}`));
    h.generation++;
    expect(accountDirectory('anthropic', id)).toBe(directory);
    h.owner = 'owner-b';
    expect(() => readBoundClaudeConfigDir('secondary')).toThrow('unavailable');
    expect(() => accountDirectory('anthropic', id)).toThrow('unavailable');
    expect(() => accountDirectory('openai', '../../other')).toThrow('unavailable');
  });
  it('returns only a stable error code when a native process includes private details', async () => {
    h.execute.mockRejectedValue(new Error('fixture-private-auth-detail'));
    await expect(
      invoke({ action: 'add', providerId: 'openai', loginKey: 'login' }),
    ).rejects.toThrow('[SUBSCRIPTION_ACCOUNT_FAILED]');
    h.execute.mockRejectedValue(new Error('login_cancelled'));
    await expect(
      invoke({ action: 'add', providerId: 'openai', loginKey: 'login' }),
    ).rejects.toThrow('[SUBSCRIPTION_LOGIN_CANCELLED]');
  });
});
