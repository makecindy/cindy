import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ scope: 'owner-a', boundaryPending: false, owned: [] as unknown[] }));
const clipboard = vi.hoisted(() => ({ remember: vi.fn() }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.scope,
  isAppSessionBoundaryPending: () => state.boundaryPending,
}));
vi.mock('../../textClipboard.js', () => ({ rememberIssuedClipboardText: clipboard.remember }));
vi.mock('../../authManager.js', () => ({ getAuthState: () => ({ isAuthenticated: true }), getDeviceId: () => 'host-device' }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../maker-host/remote-provider-access-store.js', () => ({ isRemoteProviderInvocationAllowed: () => true }));
vi.mock('../settings-store.js', () => ({ readDeviceLinkSettings: () => ({ remoteControlEnabled: true }) }));
vi.mock('../providerShareApi.js', () => ({
  providerShareOwnerKey: () => state.scope,
  providerShareApi: { listOwned: async () => state.owned },
}));

type Host = typeof import('../providerShareHost');
let dir: string;
let ownerA: string;
let ownerB: string;
let host: Host;
let windows: typeof import('../providerShareApprovalWindows');
const events = () => ({ changed: vi.fn(), requested: vi.fn(), watchedRequested: vi.fn(), revoked: vi.fn(), reconcile: vi.fn() });
const request = { requestId: 'request-1', displayName: 'Guest', avatarUrl: null, region: 'global' as const,
  pairingCode: '0123', createdAt: '2026-10-15T08:00:00Z', expiresAt: '2026-10-16T08:00:00Z' };
const LINK_A = 'a'.repeat(64);
const LINK_B = 'b'.repeat(64);
const LINK_C = 'c'.repeat(64);
const ownedShare = { shareId: 'share-1', providerId: 'anthropic', providerLabel: 'Anthropic', hostDeviceId: 'host-device',
  createdAt: '2026-10-15T08:00:00Z', members: [], requests: [request] };
const filePath = () => path.join(dir, state.scope, 'provider-share-approval-windows.json');
const assertCurrent = () => { if (state.boundaryPending) throw new Error('account boundary'); };

async function loadProcess() {
  // reset-modules: explicitly simulate a complete process restart in persistence regressions, not per-test preparation.
  vi.resetModules();
  windows = await import('../providerShareApprovalWindows');
  windows.configureProviderShareApprovalWindows({ filePath, scopeKey: () => state.scope });
  host = await import('../providerShareHost');
}

beforeAll(async () => {
  windows = await import('../providerShareApprovalWindows');
  host = await import('../providerShareHost');
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-share-approval-window-'));
  // Host teardown retains state by account for runtime reconnection. Distinct
  // fake accounts keep cases isolated without reloading the module graph.
  ownerA = path.basename(dir) + '-a';
  ownerB = path.basename(dir) + '-b';
  state.scope = ownerA;
  state.boundaryPending = false;
  state.owned = [];
  clipboard.remember.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T08:00:00Z'));
  windows.configureProviderShareApprovalWindows({ filePath, scopeKey: () => state.scope });
});

afterEach(() => {
  host.stopProviderShareHost();
  windows.configureProviderShareApprovalWindows(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('approval ownership across a complete application restart', () => {
  it('retains separate remote-link quiet windows when a local link is created, including after restart', async () => {
    host.startProviderShareHost(events());
    await host.quietProviderShareRequests('anthropic', LINK_A);
    await host.quietProviderShareRequests('anthropic', LINK_C);
    await host.clearProviderShareRequestQuiet('anthropic');
    host.stopProviderShareHost();
    await loadProcess();
    const requests = [LINK_A, LINK_B, LINK_C].map((linkId, i) => ({ ...request, requestId: `request-${i}`, linkId }));
    state.owned = [{ ...ownedShare, requests }];
    const ev = events();
    host.startProviderShareHost(ev);
    await host.refreshProviderShareHost('local-link-after-restart');
    expect(ev.requested.mock.calls.map(([item, , quiet]) => [item.linkId, quiet])).toEqual([
      [LINK_A, true], [LINK_B, false], [LINK_C, true],
    ]);
  });

  it('restores multiple watches for one supplier without claiming a third computer link', async () => {
    host.startProviderShareHost(events());
    await host.watchProviderShareRequests('group-host', 'anthropic', LINK_A, async () => []);
    await host.watchProviderShareRequests('group-host', 'anthropic', LINK_B, async () => []);
    host.stopProviderShareHost();
    await loadProcess();
    const requests = [LINK_A, LINK_B, LINK_C].map((linkId, i) => ({ ...request, requestId: `request-${i}`, linkId }));
    const ev = events();
    host.startProviderShareHost(ev, { readWatchedShares: async () => [{ ...ownedShare, hostDeviceId: 'group-host', requests }] });
    await host.refreshProviderShareHost('multiple-link-restart');
    expect(ev.watchedRequested.mock.calls.map(([item]) => item.request.linkId)).toEqual([LINK_A, LINK_B]);
    await host.refreshProviderShareHost('same-snapshot');
    expect(ev.watchedRequested).toHaveBeenCalledTimes(2);
  });

  it('does not let a restored legacy watch claim an identified request', async () => {
    host.startProviderShareHost(events());
    await host.watchProviderShareRequests('group-host', 'anthropic', async () => []);
    host.stopProviderShareHost();
    await loadProcess();
    const ev = events();
    host.startProviderShareHost(ev, { readWatchedShares: async () => [{ ...ownedShare, requests: [{ ...request, linkId: LINK_B }] }] });
    await host.refreshProviderShareHost('legacy-watch-new-link');
    expect(ev.watchedRequested).not.toHaveBeenCalled();
  });

  it('expires exact ownership and isolates it from another account', async () => {
    host.startProviderShareHost(events());
    await host.quietProviderShareRequests('anthropic', LINK_A);
    await host.watchProviderShareRequests('group-host', 'anthropic', LINK_A, async () => []);
    host.stopProviderShareHost();
    await loadProcess();
    const identified = { ...request, linkId: LINK_A };
    state.owned = [{ ...ownedShare, requests: [identified] }];
    state.scope = ownerB;
    const other = events();
    const readWatchedShares = vi.fn(async () => [{ ...ownedShare, requests: [identified] }]);
    host.startProviderShareHost(other, { readWatchedShares });
    await host.refreshProviderShareHost('other-account-exact');
    expect(other.requested).toHaveBeenCalledWith(identified, expect.anything(), false);
    expect(readWatchedShares).not.toHaveBeenCalled();
    host.stopProviderShareHost();
    state.scope = ownerA;
    vi.setSystemTime(Date.now() + windows.PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS + 1);
    const expired = events();
    host.startProviderShareHost(expired, { readWatchedShares });
    await host.refreshProviderShareHost('expired-exact');
    expect(expired.requested).toHaveBeenCalledWith(identified, expect.anything(), false);
    expect(readWatchedShares).not.toHaveBeenCalled();
    expect(windows.readProviderShareApprovalWindows()).toEqual({ quietUntil: {}, watches: [] });
  });

  it('routes watched requests only to the exact link that was generated here', async () => {
    const watched = events();
    const remote = { ...ownedShare, hostDeviceId: 'group-host', requests: [{ ...request, requestId: 'request-b', linkId: LINK_B }] };
    host.startProviderShareHost(watched);
    await host.watchProviderShareRequests('group-host', 'anthropic', LINK_A, async () => [remote]);
    await host.refreshProviderShareHost('exact-link');
    expect(watched.watchedRequested).not.toHaveBeenCalled();

    const matching = { ...remote, requests: [{ ...request, requestId: 'request-a', linkId: LINK_A }] };
    await host.watchProviderShareRequests('group-host', 'anthropic', LINK_A, async () => [matching]);
    await host.refreshProviderShareHost('exact-link-match');
    expect(watched.watchedRequested).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ linkId: LINK_A }) }));
  });

  it('keeps the supplier computer quiet before its first snapshot after restart', async () => {
    host.startProviderShareHost(events());
    await host.quietProviderShareRequests('anthropic');
    host.stopProviderShareHost();
    await loadProcess(); // 丢掉模块内存，模拟完整 Electron 主进程重启。
    state.owned = [ownedShare];
    const ev = events();
    host.startProviderShareHost(ev);
    await host.refreshProviderShareHost('restart');
    expect(ev.requested).toHaveBeenCalledWith(request, expect.anything(), true);
  });

  it('rebuilds the generating computer reader and continues polling after restart', async () => {
    host.startProviderShareHost(events());
    await host.watchProviderShareRequests('group-host', 'anthropic', async () => []);
    host.stopProviderShareHost();
    await loadProcess();
    const readWatchedShares = vi.fn(async () => [{ ...ownedShare, hostDeviceId: 'group-host' }]);
    const ev = events();
    host.startProviderShareHost(ev, { readWatchedShares });
    await host.refreshProviderShareHost('restart');
    expect(readWatchedShares).toHaveBeenCalledWith('group-host');
    expect(ev.watchedRequested).toHaveBeenCalledWith(expect.objectContaining({ request, hostDeviceId: 'group-host' }));
    expect(host.getProviderShareHostSnapshot()).toEqual([]);
  });

  it('does not restore an expired quiet window', async () => {
    host.startProviderShareHost(events());
    await host.quietProviderShareRequests('anthropic');
    host.stopProviderShareHost();
    vi.setSystemTime(Date.now() + windows.PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS + 1);
    await loadProcess();
    state.owned = [ownedShare];
    const ev = events();
    host.startProviderShareHost(ev);
    await host.refreshProviderShareHost('expired');
    expect(ev.requested).toHaveBeenCalledWith(request, expect.anything(), false);
  });

  it('persists a local link clearing the previous quiet window', async () => {
    host.startProviderShareHost(events());
    await host.quietProviderShareRequests('anthropic');
    await host.clearProviderShareRequestQuiet('anthropic');
    host.stopProviderShareHost();
    await loadProcess();
    state.owned = [ownedShare];
    const ev = events();
    host.startProviderShareHost(ev);
    await host.refreshProviderShareHost('local-link');
    expect(ev.requested).toHaveBeenCalledWith(request, expect.anything(), false);
  });

  it('does not read another account ownership and restores it after switching back', async () => {
    host.startProviderShareHost(events());
    await host.quietProviderShareRequests('anthropic');
    host.stopProviderShareHost();
    await loadProcess();
    state.scope = ownerB;
    state.owned = [ownedShare];
    const other = events();
    host.startProviderShareHost(other);
    await host.refreshProviderShareHost('other-account');
    expect(other.requested).toHaveBeenCalledWith(request, expect.anything(), false);
    host.stopProviderShareHost();
    state.scope = ownerA;
    const original = events();
    host.startProviderShareHost(original);
    await host.refreshProviderShareHost('original-account');
    expect(original.requested).toHaveBeenCalledWith(request, expect.anything(), true);
  });
});

describe('approval ownership storage', () => {
  it.each(['quiet', 'clear', 'watch'] as const)('rejects %s setup after the runtime stops without changing stored ownership', async (action) => {
    host.startProviderShareHost(events());
    if (action === 'clear') await host.quietProviderShareRequests('anthropic');
    host.stopProviderShareHost();
    const original = fs.existsSync(filePath()) ? fs.readFileSync(filePath(), 'utf8') : null;
    const setup = action === 'quiet' ? host.quietProviderShareRequests('anthropic')
      : action === 'clear' ? host.clearProviderShareRequestQuiet('anthropic')
        : host.watchProviderShareRequests('group-host', 'anthropic', async () => []);
    await expect(setup).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(fs.existsSync(filePath()) ? fs.readFileSync(filePath(), 'utf8') : null).toBe(original);
  });

  it('does not expose a remote link when its reply arrives after the approval runtime stops', async () => {
    const { invokeProviderManagement } = await import('../../provider-group/managementClient');
    host.startProviderShareHost(events());
    const invoke = vi.fn(async () => {
      host.stopProviderShareHost(); // 回包已到，账号没变，但设备互联的 runtime 已被停止。
      return { ok: true as const, result: {
        result: { link: 'https://cindy.app/s#test', linkId: LINK_A, expiresAt: new Date(Date.now() + 60_000).toISOString() },
        respondedAt: Date.now(),
      } };
    });
    await expect(invokeProviderManagement(invoke, 'group-host', {
      action: 'manage-share', command: { action: 'create-link', providerId: 'anthropic' },
    })).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(clipboard.remember).not.toHaveBeenCalled();
    expect(fs.existsSync(filePath())).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps both sides of concurrently saved windows without storing link or person details', async () => {
    const until = Date.now() + windows.PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS;
    await Promise.all([
      windows.updateProviderShareApprovalWindows((current) => ({ ...current, quietUntil: { ...current.quietUntil, anthropic: until } }), assertCurrent),
      windows.updateProviderShareApprovalWindows((current) => ({ ...current, watches: [{ hostDeviceId: 'group-host', providerId: 'openai', until }] }), assertCurrent),
    ]);
    const stored = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    expect(stored).toEqual({ quietUntil: { anthropic: until }, watches: [{ hostDeviceId: 'group-host', providerId: 'openai', until }] });
  });

  it('preserves a corrupt file instead of overwriting it', async () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), '{broken');
    await expect(windows.updateProviderShareApprovalWindows((current) => current, assertCurrent)).rejects.toThrow();
    expect(fs.readFileSync(filePath(), 'utf8')).toBe('{broken');
  });

  it('rejects a save at an account boundary without creating a file', async () => {
    state.boundaryPending = true;
    await expect(windows.updateProviderShareApprovalWindows((current) => current, assertCurrent)).rejects.toThrow('account boundary');
    expect(fs.existsSync(filePath())).toBe(false);
  });

  it('does not commit to either account after switching while waiting for the lock', async () => {
    const originalFile = filePath();
    const until = Date.now() + windows.PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS;
    const save = windows.updateProviderShareApprovalWindows((current) => ({ ...current, quietUntil: { anthropic: until } }), assertCurrent);
    state.scope = ownerB;
    await expect(save).rejects.toThrow('Could not save provider share approval ownership');
    expect(fs.existsSync(originalFile)).toBe(false);
    expect(fs.existsSync(filePath())).toBe(false);
  });

  it('retains the previous disk state when atomic replacement fails', async () => {
    const until = Date.now() + windows.PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS;
    await windows.updateProviderShareApprovalWindows((current) => ({ ...current, quietUntil: { anthropic: until } }), assertCurrent);
    const original = fs.readFileSync(filePath(), 'utf8');
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (target === filePath()) throw Object.assign(new Error('disk write failed'), { code: 'EIO' });
      return rename(source, target);
    });
    await expect(windows.updateProviderShareApprovalWindows((current) => ({
      ...current, quietUntil: { ...current.quietUntil, openai: until },
    }), assertCurrent)).rejects.toThrow('Could not save provider share approval ownership');
    expect(fs.readFileSync(filePath(), 'utf8')).toBe(original);
  });

  it('keeps the active quiet window when clearing it fails to persist', async () => {
    host.startProviderShareHost(events());
    await host.quietProviderShareRequests('anthropic');
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (target === filePath()) throw Object.assign(new Error('private path must not escape'), { code: 'EIO' });
      return rename(source, target);
    });
    await expect(host.clearProviderShareRequestQuiet('anthropic')).rejects.toThrow('Could not save provider share approval ownership');
    state.owned = [ownedShare];
    await host.refreshProviderShareHost('save-failed');
    expect(host.getProviderShareQuietRequestIds()).toEqual(['request-1']);
  });
});
