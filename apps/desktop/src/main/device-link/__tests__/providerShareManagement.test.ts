import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';

import type { ProviderShareManagementCommand } from '../../../shared/providerManagement';
import type { ProviderUsageHistoryView } from '../../../shared/providerShare';

const state = vi.hoisted(() => ({ owner: 'owner-a', boundaryPending: false }));
const api = vi.hoisted(() => ({ createLink: vi.fn(), approve: vi.fn(), reject: vi.fn(), setMember: vi.fn() }));
const host = vi.hoisted(() => ({
  refresh: vi.fn(), snapshot: vi.fn(), quiet: vi.fn(), active: vi.fn(), decision: vi.fn(), member: vi.fn(),
}));
const listProviders = vi.hoisted(() => vi.fn());
const identityCard = vi.hoisted(() => vi.fn());
const remember = vi.hoisted(() => vi.fn());
const usageStores = vi.hoisted(() => ({ ownHistory: vi.fn(), memberHistory: vi.fn(), pricing: vi.fn() }));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.owner,
  isAppSessionBoundaryPending: () => state.boundaryPending,
}));
vi.mock('../../authManager.js', () => ({ getDeviceId: () => 'host-device' }));
vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders }),
}));
vi.mock('../../maker-host/remote-provider-access-store.js', () => ({ isRemoteProviderInvocationAllowed: () => true }));
vi.mock('../../textClipboard.js', () => ({ rememberIssuedClipboardText: remember }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: vi.fn() }));
vi.mock('../../usage/ledgerCurrency.js', () => ({ currentLedgerCurrency: vi.fn() }));
vi.mock('../../usage/modelPricing.js', () => ({ getGatewayModelPricing: usageStores.pricing, getModelPriceQuote: vi.fn() }));
vi.mock('../../usage/turnCostCalculator.js', () => ({ computePriceQuoteTurnMoney: vi.fn(), normalizeModelIdForPricing: vi.fn() }));
vi.mock('../../usage/providerPartyUsageStore.js', () => ({
  currentProviderPartyUsageStore: () => ({ history: usageStores.ownHistory }),
}));
vi.mock('../providerShareUsageStore.js', () => ({
  getProviderShareUsageStore: () => ({ history: usageStores.memberHistory }),
  providerUsageLocalDay: () => '2026-10-17',
}));
vi.mock('../settings-store.js', () => ({ readDeviceLinkSettings: () => ({ remoteControlEnabled: true }), readLastKnownDeviceNames: vi.fn() }));
vi.mock('../providerShareApi.js', () => ({
  providerShareApi: api,
  fetchIdentityCard: identityCard,
  sha256Hex: (value: string) => value,
  providerShareLinkFor: () => 'https://cindy.app/s#test-link',
}));
vi.mock('../dispatch.js', () => ({
  getControllerDisplayName: vi.fn(), providerShareActiveControllers: vi.fn(),
  revokeProviderShareControllers: vi.fn(), setProviderShareAccess: vi.fn(),
}));
vi.mock('../providerShareHost.js', () => ({
  startProviderShareHost: vi.fn(), stopProviderShareHost: vi.fn(),
  refreshProviderShareHost: host.refresh, getProviderShareHostSnapshot: host.snapshot,
  clearProviderShareRequestQuiet: vi.fn(),
  providerShareGuestAccess: vi.fn(), providerShareGuestDenial: vi.fn(), ensureProviderSharePeerKnown: vi.fn(),
  quietProviderShareRequests: host.quiet, markProviderShareHostActive: host.active,
  applyLocalRequestDecision: host.decision, applyLocalMemberChange: host.member,
}));
vi.mock('../providerShareGuest.js', () => ({ startProviderShareGuest: vi.fn(), stopProviderShareGuest: vi.fn() }));
vi.mock('../providerShareGuestPrefs.js', () => ({ configureProviderShareGuestPrefs: vi.fn(), invalidateProviderShareGuestPrefsCache: vi.fn() }));
vi.mock('../providerShareGuestPrefsIpc.js', () => ({ setProviderShareCredentialConsentFromIpc: vi.fn() }));

import {
  executeProviderShareManagementCommand,
  parseProviderShareCommand,
  registerProviderShareIpc,
  startProviderShareRuntime,
  stopProviderShareRuntime,
  trimProviderUsageHistory,
} from '../providerShareRuntime';

const createLink: ProviderShareManagementCommand = { action: 'create-link', providerId: 'anthropic' };
const LINK_ID = 'a'.repeat(64);
const mutations: ProviderShareManagementCommand[] = [
  { action: 'approve', requestId: 'r1' },
  { action: 'reject', requestId: 'r1' },
  { action: 'set-member', memberId: 'm1', status: 'remove' },
];

beforeEach(() => {
  vi.resetAllMocks();
  state.owner = 'owner-a';
  state.boundaryPending = false;
  listProviders.mockResolvedValue([{ id: 'anthropic', name: 'Anthropic', connected: true, agents: ['claude-code'] }]);
  identityCard.mockResolvedValue({ card: 'test-identity-card' });
  api.createLink.mockResolvedValue({ invitation: 'test-invitation', linkId: LINK_ID });
  api.approve.mockResolvedValue({ ok: true });
  api.reject.mockResolvedValue({ ok: true });
  api.setMember.mockResolvedValue({ status: 'removed' });
  host.refresh.mockResolvedValue(undefined);
  host.snapshot.mockReturnValue([{ requests: [{ requestId: 'r1' }], members: [{ memberId: 'm1' }] }]);
  usageStores.ownHistory.mockReturnValue({ self: { lastUsedAt: null, days: [] }, relays: [] });
  usageStores.memberHistory.mockReturnValue([]);
  startProviderShareRuntime(vi.fn());
});

afterEach(() => stopProviderShareRuntime());

const historyRow = (index: number, model = 'model-' + index): ProviderUsageHistoryView['self']['days'][number] => ({
  day: '2026-10-17',
  kind: 'claude-code',
  providerId: 'anthropic',
  memberKey: 'local',
  model,
  turns: 1,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  amount: null,
});

const historyWithRows = (rows: ProviderUsageHistoryView['self']['days']): ProviderUsageHistoryView => ({
  providerId: 'anthropic',
  todayKey: '2026-10-17',
  coverageStart: null,
  self: { lastUsedAt: null, days: rows },
  relays: [],
  members: [],
});

describe('provider share usage history wire budget', () => {
  it('caps the global row count even when the newest day alone has more rows', () => {
    const trimmed = trimProviderUsageHistory(historyWithRows(Array.from({ length: 5_001 }, (_, index) => historyRow(index))));
    expect(trimmed.self.days).toHaveLength(5_000);
    expect(trimmed.coverageStart).toBe('2026-10-17');
  });

  it('also trims by UTF-8 JSON bytes and reports the retained date', () => {
    const rows = Array.from({ length: 4_000 }, (_, index) => '模型-' + index + '-' + '很'.repeat(600))
      .map((model, index) => historyRow(index, model));
    const trimmed = trimProviderUsageHistory(historyWithRows(rows));
    expect(trimmed.self.days.length).toBeLessThan(rows.length);
    expect(Buffer.byteLength(JSON.stringify(trimmed), 'utf8')).toBeLessThanOrEqual(2 * 1024 * 1024 - 1_024);
    expect(trimmed.coverageStart).toBe('2026-10-17');
  });

  it('bounds ledger expansion and prices only the globally retained rows, preserving SDK costs and truncation', async () => {
    const rawRows = Array.from({ length: 5_001 }, (_, index) => {
      return { ...historyRow(index), sdkCostUsd: 0.25 };
    });
    usageStores.ownHistory.mockReturnValue({ self: { lastUsedAt: null, days: rawRows }, relays: [] });
    host.snapshot.mockReturnValue([{ providerId: 'anthropic', shareId: 's', members: [{ memberId: 'm1' }] }]);
    const result = await executeProviderShareManagementCommand({ action: 'usage-history', providerId: 'anthropic' }) as ProviderUsageHistoryView;
    expect(usageStores.memberHistory).toHaveBeenCalledWith(new Set(['s']), {
      maxRows: 5_001, memberKeys: new Set([JSON.stringify(['s', 'm1'])]),
    });
    expect(usageStores.pricing).toHaveBeenCalledTimes(5_000);
    expect(result.self.days).toHaveLength(5_000);
    expect(result.self.days[0]?.amount).toEqual({ amount: 0.25, currency: 'USD' });
    expect(result.self.days[0]).not.toHaveProperty('sdkCostUsd');
    expect(result.coverageStart).toBe('2026-10-17');
  });
});

describe('remote task limit management payloads', () => {
  it.each([{ perDevice: 24 }, { total: 80 }, { perDevice: 16, total: 64 }])('preserves only supplied fields in %j', limits => {
    expect(parseProviderShareCommand({ action: 'set-run-limits', limits })).toEqual({ action: 'set-run-limits', limits });
  });
  it.each([{}, { unknown: 1 }, { perDevice: '16' }, { perDevice: 0 }, { total: 1001 }, { total: 1.5 }])('rejects malformed patches %j', limits => {
    expect(() => parseProviderShareCommand({ action: 'set-run-limits', limits })).toThrow('INVALID_PARAMS');
  });
});

describe('same-account share management during account transitions', () => {
  it.each([
    createLink, ...mutations,
    { action: 'get-run-limits' },
    { action: 'set-run-limits', limits: { perDevice: 16, total: 64 } },
    { action: 'reset-run-limits' },
    { action: 'owned', range: '7d' },
    { action: 'own-usage', providerId: 'anthropic', range: '7d' },
    { action: 'usage-history', providerId: 'anthropic' },
  ] satisfies ProviderShareManagementCommand[])('refuses $action at entry while teardown is pending', async (command) => {
    state.boundaryPending = true;
    await expect(executeProviderShareManagementCommand(command)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(listProviders).not.toHaveBeenCalled();
    expect(host.refresh).not.toHaveBeenCalled();
    expect(api.createLink).not.toHaveBeenCalled();
    expect(api.approve).not.toHaveBeenCalled();
    expect(api.reject).not.toHaveBeenCalled();
    expect(api.setMember).not.toHaveBeenCalled();
  });

  it.each(mutations)('does not submit $action when teardown begins during membership refresh', async (command) => {
    host.refresh.mockImplementationOnce(async () => { state.boundaryPending = true; });
    await expect(executeProviderShareManagementCommand(command)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(api.approve).not.toHaveBeenCalled();
    expect(api.reject).not.toHaveBeenCalled();
    expect(api.setMember).not.toHaveBeenCalled();
  });

  it.each(['provider lookup', 'identity card', 'link response'])('stops link creation when teardown begins during %s', async (stage) => {
    if (stage === 'provider lookup') listProviders.mockImplementationOnce(async () => { state.boundaryPending = true; return []; });
    if (stage === 'identity card') identityCard.mockImplementationOnce(async () => { state.boundaryPending = true; return {}; });
    if (stage === 'link response') api.createLink.mockImplementationOnce(async () => { state.boundaryPending = true; return {}; });
    await expect(executeProviderShareManagementCommand(createLink)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(identityCard).toHaveBeenCalledTimes(stage === 'provider lookup' ? 0 : 1);
    expect(api.createLink).toHaveBeenCalledTimes(stage === 'link response' ? 1 : 0);
    expect(host.active).not.toHaveBeenCalled();
    expect(host.refresh).not.toHaveBeenCalled();
    expect(host.quiet).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });

  it.each(mutations)('discards a late $action result before changing local approval or membership state', async (command) => {
    const changeBoundary = async () => { state.boundaryPending = true; return { status: 'removed' }; };
    api.approve.mockImplementationOnce(changeBoundary);
    api.reject.mockImplementationOnce(changeBoundary);
    api.setMember.mockImplementationOnce(changeBoundary);
    await expect(executeProviderShareManagementCommand(command)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(host.decision).not.toHaveBeenCalled();
    expect(host.member).not.toHaveBeenCalled();
    expect(host.refresh).toHaveBeenCalledExactlyOnceWith('management');
  });

  it('also discards a link response after a committed account switch', async () => {
    api.createLink.mockImplementationOnce(async () => { state.owner = 'owner-b'; return {}; });
    await expect(executeProviderShareManagementCommand(createLink)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(host.quiet).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });

  it.each(mutations)('executes $action once and updates local state when the account is stable', async (command) => {
    await expect(executeProviderShareManagementCommand(command)).resolves.toEqual({ ok: true });
    if (command.action === 'set-member') {
      expect(api.setMember).toHaveBeenCalledExactlyOnceWith('m1', 'remove');
      expect(host.member).toHaveBeenCalledExactlyOnceWith('m1', 'removed');
    } else if (command.action === 'approve' || command.action === 'reject') {
      expect(api[command.action]).toHaveBeenCalledExactlyOnceWith('r1');
      expect(host.decision).toHaveBeenCalledExactlyOnceWith('r1');
    }
  });

  it('creates and registers a link when the account is stable', async () => {
    await expect(executeProviderShareManagementCommand(createLink)).resolves.toMatchObject({ link: 'https://cindy.app/s#test-link', linkId: LINK_ID });
    expect(api.createLink).toHaveBeenCalledTimes(1);
    expect(host.quiet).toHaveBeenCalledExactlyOnceWith('anthropic', LINK_ID);
    expect(remember).toHaveBeenCalledExactlyOnceWith('https://cindy.app/s#test-link', expect.any(String));
  });

  it('rejects an old server before exposing or registering a remote link', async () => {
    api.createLink.mockResolvedValueOnce({ invitation: 'test-invitation' });
    await expect(executeProviderShareManagementCommand(createLink)).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(host.quiet).not.toHaveBeenCalled();
    expect(host.active).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });

  it('still creates local share links with an old server', async () => {
    api.createLink.mockResolvedValueOnce({ invitation: 'test-invitation' });
    const handle = vi.spyOn(ipcMain, 'handle');
    try {
      registerProviderShareIpc();
      const handler = handle.mock.calls.find(([channel]) => channel === 'provider-share:command')![1];
      await expect(handler({} as Electron.IpcMainInvokeEvent, createLink)).resolves.toMatchObject({ link: 'https://cindy.app/s#test-link' });
      expect(host.quiet).not.toHaveBeenCalled();
      expect(remember).toHaveBeenCalledTimes(1);
    } finally {
      handle.mockRestore();
    }
  });

  it('does not register a link when saving its host ownership fails', async () => {
    host.quiet.mockRejectedValueOnce(new Error('ownership save failed'));
    await expect(executeProviderShareManagementCommand(createLink)).rejects.toThrow('ownership save failed');
    expect(remember).not.toHaveBeenCalled();
  });
});
