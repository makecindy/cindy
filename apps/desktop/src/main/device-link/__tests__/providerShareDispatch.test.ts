/**
 * 被控端对供应商分享受邀者(另一个账号)的入口：只建后台链路、只放行远程 Agent 与过滤后的供应商列表，
 * 订阅与其他通道一律拒绝；撤权后迟到的结果不再带出数据；撤权只会命中受邀者对端。
 */
import { providerShareGuestPeer, PROVIDER_SHARE_RELAY_CAPABILITY, type DeviceLinkClient } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ access: null as null | { shareId: string; memberId: string; providerId: string } }));

vi.mock('electron-store', () => ({ default: class {} }));
vi.mock('electron', () => ({
  app: { getAppPath: () => '/tmp/cindy-test/app', getPath: () => '/tmp/cindy-test', getVersion: () => '0.0.0-test' },
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
const warn = vi.hoisted(() => vi.fn());
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() }),
}));
vi.mock('../settings-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-store')>()),
  readDeviceLinkSettings: () => ({ remoteControlEnabled: true, keepAwake: false, revokedControllers: [], disabledControlDeviceIds: [] }),
}));

import {
  __testing,
  providerShareActiveControllers,
  revokeProviderShareControllers,
  runInvoke,
  setProviderShareAccess,
  setRemoteAgentHandler,
} from '../dispatch';

const GUEST = providerShareGuestPeer('share-1', 'member-1', 'laptop');
const ACCESS = { shareId: 'share-1', memberId: 'member-1', providerId: 'anthropic' };

function fakeClient() {
  return {
    sendLinkAccept: vi.fn(),
    closeLink: vi.fn(),
    getConnectionEpoch: () => 1,
    getStatus: () => 'online',
    sendInvokeResult: vi.fn(),
  } as unknown as DeviceLinkClient & { sendLinkAccept: ReturnType<typeof vi.fn>; closeLink: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  __testing.reset();
  state.access = null;
  setProviderShareAccess({ guestAccess: () => state.access, ensureKnown: async () => undefined, hasShares: () => false });
});
afterEach(() => {
  __testing.reset();
  setProviderShareAccess(null);
});

describe('provider share link admission', () => {
  it('accepts an admitted guest that declares the capability, as a background link only', () => {
    state.access = ACCESS;
    const client = fakeClient();
    __testing.handleLinkOpen(client, GUEST, 'req-1', { capabilities: [PROVIDER_SHARE_RELAY_CAPABILITY] } as never, 0, true);
    expect(client.sendLinkAccept).toHaveBeenCalledTimes(1);
    expect(client.sendLinkAccept.mock.calls[0][2].capabilities).toContain(PROVIDER_SHARE_RELAY_CAPABILITY);
    expect(client.closeLink).not.toHaveBeenCalled();
    expect(__testing.getActiveControllers()).toEqual([]);
  });

  it('logs why a guest is refused, at most once a minute per reason', async () => {
    warn.mockClear();
    setProviderShareAccess({
      guestAccess: () => null, ensureKnown: async () => undefined, hasShares: () => true,
      denial: () => 'provider-not-remote',
    });
    await runInvoke(GUEST, { channel: 'maker:provider:list', args: [] });
    await runInvoke(GUEST, { channel: 'maker:provider:list', args: [] });
    const refusals = warn.mock.calls.filter(([line]) => String(line).startsWith('provider-share guest refused'));
    expect(refusals).toHaveLength(1);
    expect(String(refusals[0][0])).toContain('invoke maker:provider:list');
    expect(String(refusals[0][0])).toContain('provider-not-remote');
  });

  it('refuses guests without access or without the capability', () => {
    const client = fakeClient();
    __testing.handleLinkOpen(client, GUEST, 'req-1', { capabilities: [PROVIDER_SHARE_RELAY_CAPABILITY] } as never, 0, true);
    state.access = ACCESS;
    __testing.handleLinkOpen(client, GUEST, 'req-2', { capabilities: [] } as never, 0, true);
    expect(client.sendLinkAccept).not.toHaveBeenCalled();
    expect(client.closeLink).toHaveBeenCalledTimes(2);
  });
});

describe('provider share invoke', () => {
  it('allows only the remote agent and the filtered provider list', async () => {
    state.access = ACCESS;
    const handle = vi.fn(async () => ({ ok: true }));
    setRemoteAgentHandler({ handle, abortAll: vi.fn() });
    await expect(runInvoke(GUEST, { channel: 'local-db:sessions:list', args: [] }))
      .resolves.toMatchObject({ ok: false, error: { code: 'CHANNEL_NOT_ALLOWED' } });
    await expect(runInvoke(GUEST, { channel: 'device-link:subscribe', args: [] }))
      .resolves.toMatchObject({ ok: false, error: { code: 'CHANNEL_NOT_ALLOWED' } });
    await expect(runInvoke(GUEST, { channel: 'maker:remote-agent:v1', args: [{ op: 'caps' }] }))
      .resolves.toEqual({ ok: true, result: { ok: true } });
    expect(handle).toHaveBeenCalledWith(GUEST, { op: 'caps' });
    expect(__testing.handleSubscriptionFrame(GUEST, { channel: 'device-link:subscribe', args: [] }))
      .toMatchObject({ ok: false, error: { code: 'ACCESS_REVOKED' } });
  });

  it('refuses everything once access is gone, including results already computed', async () => {
    state.access = ACCESS;
    const handle = vi.fn(async () => {
      state.access = null;
      return { secret: true };
    });
    setRemoteAgentHandler({ handle, abortAll: vi.fn() });
    await expect(runInvoke(GUEST, { channel: 'maker:remote-agent:v1', args: [] }))
      .resolves.toMatchObject({ ok: false, error: { code: 'ACCESS_REVOKED' } });
    await expect(runInvoke(GUEST, { channel: 'maker:remote-agent:v1', args: [] }))
      .resolves.toMatchObject({ ok: false, error: { code: 'ACCESS_REVOKED' } });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('answers the picker reads narrowed to the shared provider', async () => {
    state.access = ACCESS;
    const { __testing: registry } = await import('../invoke-registry');
    registry.reset();
    registry.register('maker:provider:list', async () => ({
      dataOwnerId: 'owner-1',
      ownerGeneration: 1,
      providers: [
        { id: 'anthropic', name: 'Anthropic', agents: ['claude-code'], remoteInvocationEnabled: true, models: { 'claude-code': [{ id: 'claude-opus-5-5' }] } },
        { id: 'openai', name: 'OpenAI', agents: ['codex'], remoteInvocationEnabled: true, models: { codex: [{ id: 'gpt-5.5' }] } },
      ],
    }));
    registry.register('maker:get-capabilities', async () => ({
      availableModels: [{ id: 'claude-opus-5-5' }, { id: 'claude-opus-5-5[1m]' }, { id: 'claude-sonnet-5' }, { id: 'gpt-5.5' }],
      permissionModes: [{ id: 'default' }],
    }));
    registry.register('maker:list-available-agents', async () => ['claude-code', 'codex', 'pi']);
    registry.register('maker:agent:status', async () => ({
      binaryReady: true, binaryPath: '/Users/alice/bin/claude', authReady: true, identity: 'alice@corp.com',
    }));
    try {
      await expect(runInvoke(GUEST, { channel: 'maker:get-capabilities', args: ['claude-code'] })).resolves.toEqual({
        ok: true,
        // Exact ids: `x[1m]` is a separate catalog model the shared provider does not list.
        result: { availableModels: [{ id: 'claude-opus-5-5' }], permissionModes: [{ id: 'default' }] },
      });
      await expect(runInvoke(GUEST, { channel: 'maker:get-capabilities', args: ['codex'] }))
        .resolves.toMatchObject({ ok: true, result: { availableModels: [] } });
      await expect(runInvoke(GUEST, { channel: 'maker:list-available-agents', args: [] }))
        .resolves.toEqual({ ok: true, result: ['claude-code'] });
      // Readiness only says whether an agent the share serves is installed (no sign-in, path or identity).
      await expect(runInvoke(GUEST, { channel: 'maker:agent:status', args: ['claude-code'] }))
        .resolves.toEqual({ ok: true, result: { binaryReady: true } });
      await expect(runInvoke(GUEST, { channel: 'maker:agent:status', args: ['codex'] }))
        .resolves.toEqual({ ok: true, result: { binaryReady: false } });
      await expect(runInvoke(GUEST, { channel: 'maker:get-capabilities', args: ['../x'] }))
        .resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining('INVALID_PARAMS') } });
      // A failed read of the shared provider is reported, not answered as an empty list.
      registry.register('maker:provider:list', async () => {
        throw new Error('[MODEL_VISIBILITY_NOT_READY] later');
      });
      await expect(runInvoke(GUEST, { channel: 'maker:list-available-agents', args: [] }))
        .resolves.toMatchObject({ ok: false });
    } finally {
      registry.reset();
    }
  });

  it('projects the provider list down to the shared provider', () => {
    const projected = __testing.projectProviderListForShare({
      dataOwnerId: 'owner-membership-1',
      ownerGeneration: 3,
      providers: [
        { id: 'anthropic', remoteInvocationEnabled: true },
        { id: 'openai', remoteInvocationEnabled: true },
        { id: 'xd', remoteInvocationEnabled: false },
      ],
      modelVisibilityOverrides: { 'claude-code:anthropic:opus': false, 'codex:openai:gpt': false },
      providerOrder: ['xd', 'openai', 'anthropic'],
    }, 'anthropic') as { providers: Array<{ id: string }>; modelVisibilityOverrides: Record<string, boolean>; providerOrder: string[] };
    expect(projected.providers.map((provider) => provider.id)).toEqual(['anthropic']);
    expect(projected.modelVisibilityOverrides).toEqual({ 'claude-code:anthropic:opus': false });
    expect(projected.providerOrder).toEqual(['anthropic']);
    expect(Object.keys(projected).sort()).toEqual(['modelVisibilityOverrides', 'providerOrder', 'providers']);
    expect((__testing.projectProviderListForShare({
      providers: [{ id: 'anthropic', remoteInvocationEnabled: false }],
    }, 'anthropic') as { providers: unknown[] }).providers).toEqual([]);
  });

  it('never hands the sharer account identity to the guest', () => {
    const projected = __testing.projectProviderListForShare({
      providers: [{
        id: 'openai-2', name: 'OpenAI · alice@corp.com', remoteInvocationEnabled: true,
        openAiAccount: { source: 'oauth', identity: 'alice@corp.com' },
        subscriptionAccount: { source: 'local', identity: 'alice@corp.com' },
      }],
    }, 'openai-2') as { providers: Array<Record<string, unknown>> };
    expect(projected.providers[0]).toEqual({ id: 'openai-2', name: 'OpenAI', remoteInvocationEnabled: true });
    expect(JSON.stringify(projected)).not.toContain('alice@corp.com');
  });
});

describe('provider share revoke', () => {
  it('only touches provider-share guests and routes purge to the remote agent host', async () => {
    const abortControllers = vi.fn<(match: (controller: string) => boolean) => Promise<void>>(async () => undefined);
    const purgeControllers = vi.fn<(match: (controller: string) => boolean) => Promise<void>>(async () => undefined);
    setRemoteAgentHandler({
      handle: vi.fn(),
      abortAll: vi.fn(),
      abortControllers,
      purgeControllers,
      activeControllers: () => [GUEST, 'same-account-mac'],
    });
    expect(providerShareActiveControllers()).toEqual([GUEST]);
    await revokeProviderShareControllers(() => true, false);
    const abortMatch = abortControllers.mock.calls[0][0];
    expect(abortMatch(GUEST)).toBe(true);
    expect(abortMatch('same-account-mac')).toBe(false);
    await revokeProviderShareControllers(() => true, true);
    expect(purgeControllers).toHaveBeenCalledTimes(1);
  });
});
