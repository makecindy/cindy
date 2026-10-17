/**
 * 同账号管理的控制端：只转发明确的管理操作；本机生成的链接由本机弹审批窗(provider-sharing.md §4.1 第 4 步)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ owner: 'owner-a', boundaryPending: false }));
const host = vi.hoisted(() => ({ watch: vi.fn(), forget: vi.fn() }));
const clipboard = vi.hoisted(() => ({ remember: vi.fn() }));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.owner,
  isAppSessionBoundaryPending: () => state.boundaryPending,
}));
vi.mock('../../device-link/providerShareHost.js', () => ({
  watchProviderShareRequests: host.watch,
  forgetWatchedProviderShareRequest: host.forget,
}));
vi.mock('../../textClipboard.js', () => ({ rememberIssuedClipboardText: clipboard.remember }));

import { PROVIDER_GROUP_REMOTE_CHANNEL } from '@cindy/device-link';

import type { ProviderManagementRequest } from '../../../shared/providerManagement';
import { invokeProviderManagement } from '../managementClient';
import type { ProviderGroupRemoteInvoke } from '../remoteClient';

function replying(result: unknown): ProviderGroupRemoteInvoke {
  return vi.fn(async () => ({ ok: true, result: { result, respondedAt: Date.now() } })) as unknown as ProviderGroupRemoteInvoke;
}

const createLink: ProviderManagementRequest = { action: 'manage-share', command: { action: 'create-link', providerId: 'anthropic' } };
const LINK_ID = 'a'.repeat(64);

beforeEach(() => {
  state.owner = 'owner-a';
  state.boundaryPending = false;
  host.watch.mockReset();
  host.forget.mockReset();
  clipboard.remember.mockReset();
});

describe('provider management client', () => {
  it.each(['get-run-limits', 'set-run-limits', 'reset-run-limits'] as const)('reports an old computer for %s instead of accepting an unknown command', async (action) => {
    const invoke: ProviderGroupRemoteInvoke = async () => ({ ok: false, error: { code: 'IPC_ERROR', message: '[INVALID_PARAMS] Unknown command' } });
    const command = action === 'set-run-limits' ? { action, limits: { perDevice: 16, total: 64 } } : { action };
    await expect(invokeProviderManagement(invoke, 'old-computer', { action: 'manage-share', command })).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
  });
  it('does not dispatch management while account teardown is pending with the same owner key', async () => {
    state.boundaryPending = true;
    const invoke = replying(null);
    await expect(invokeProviderManagement(invoke, 'group-host', createLink)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rechecks the account boundary after waiting to send', async () => {
    const send = vi.fn();
    const invoke: ProviderGroupRemoteInvoke = async (_deviceId, _channel, _args, options) => {
      state.boundaryPending = true;
      options?.preSend?.();
      send();
      return { ok: true };
    };
    await expect(invokeProviderManagement(invoke, 'group-host', createLink)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    createLink,
    { action: 'manage-share', command: { action: 'approve', requestId: 'r1' } },
  ] satisfies ProviderManagementRequest[])('drops a $command.action reply during teardown before changing local state', async (request) => {
    const invoke: ProviderGroupRemoteInvoke = async () => {
      state.boundaryPending = true;
      return { ok: true, result: { result: { link: 'https://cindy.app/s#test', linkId: LINK_ID, expiresAt: new Date(Date.now() + 60_000).toISOString() }, respondedAt: Date.now() } };
    };
    await expect(invokeProviderManagement(invoke, 'group-host', request)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(host.watch).not.toHaveBeenCalled();
    expect(host.forget).not.toHaveBeenCalled();
    expect(clipboard.remember).not.toHaveBeenCalled();
  });

  it('watches the group computer\'s share after generating a link there, so the request prompts here', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const invoke = replying({ link: 'https://cindy.app/s#token', linkId: LINK_ID, expiresAt });
    const snapshot = { ready: true, shares: [{ shareId: 'share-1', providerId: 'anthropic', providerLabel: 'Anthropic', requests: [] }] };
    const readInvoke = replying(snapshot);
    const created = await invokeProviderManagement(invoke, 'group-host', createLink, readInvoke) as { link: string };
    expect(invoke).toHaveBeenCalledWith('group-host', PROVIDER_GROUP_REMOTE_CHANNEL, [createLink], expect.anything());
    expect(created.link).toBe('https://cindy.app/s#token');
    expect(clipboard.remember).toHaveBeenCalledWith('https://cindy.app/s#token', expect.any(String));
    expect(host.watch).toHaveBeenCalledWith('group-host', 'anthropic', LINK_ID, expect.any(Function));
    const readShares = host.watch.mock.calls[0][3];
    await expect(readShares()).resolves.toEqual(snapshot.shares);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(readInvoke).toHaveBeenCalledWith('group-host', PROVIDER_GROUP_REMOTE_CHANNEL, [
      { action: 'manage-share', command: { action: 'owned', range: '7d' } },
    ], expect.anything());
    vi.mocked(readInvoke).mockResolvedValue({ ok: true, result: { result: { ready: false, shares: [] }, respondedAt: Date.now() } });
    await expect(readShares()).rejects.toThrow(/PRECONDITION_FAILED/);
  });

  it('does not watch when the link response is invalid or the account changed on the way', async () => {
    await expect(invokeProviderManagement(replying({ link: '', linkId: LINK_ID }), 'group-host', createLink)).rejects.toThrow(/PRECONDITION_FAILED/);
    const switching = vi.fn(async () => {
      state.owner = 'owner-b';
      return { ok: true, result: { result: { link: 'x', linkId: LINK_ID, expiresAt: new Date().toISOString() }, respondedAt: Date.now() } };
    }) as unknown as ProviderGroupRemoteInvoke;
    await expect(invokeProviderManagement(switching, 'group-host', createLink)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(host.watch).not.toHaveBeenCalled();
    expect(clipboard.remember).not.toHaveBeenCalled();
  });

  it.each([undefined, 'not-a-digest', 'A'.repeat(64), null])('does not copy or watch a remote link with invalid linkId %s', async (linkId) => {
    const invoke = replying({ link: 'https://cindy.app/s#test', linkId, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await expect(invokeProviderManagement(invoke, 'group-host', createLink))
      .rejects.toThrow(linkId === undefined ? /UNSUPPORTED_CAPABILITY/ : /PRECONDITION_FAILED/);
    expect(host.watch).not.toHaveBeenCalled();
    expect(clipboard.remember).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not register a link for copying until its approval watch has been saved', async () => {
    let finishSave!: () => void;
    host.watch.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    const invoke = replying({ link: 'https://cindy.app/s#test', linkId: LINK_ID, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const creating = invokeProviderManagement(invoke, 'group-host', createLink);
    await vi.waitFor(() => expect(host.watch).toHaveBeenCalledTimes(1));
    expect(clipboard.remember).not.toHaveBeenCalled();
    finishSave();
    await expect(creating).resolves.toMatchObject({ link: 'https://cindy.app/s#test' });
    expect(clipboard.remember).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not subtract link creation time before the remote response', async () => {
    let now = 100_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const invoke: ProviderGroupRemoteInvoke = vi.fn(async () => {
        now = 200_000;
        return {
          ok: true,
          result: {
            result: { link: 'https://cindy.app/s#slow', linkId: LINK_ID, expiresAt: new Date(1_300_000).toISOString() },
            respondedAt: 1_000_000,
          },
        };
      }) as unknown as ProviderGroupRemoteInvoke;
      host.watch.mockImplementationOnce(async () => {
        now = 230_000;
      });

      await expect(invokeProviderManagement(invoke, 'group-host', createLink)).resolves.toMatchObject({
        link: 'https://cindy.app/s#slow',
      });
      expect(clipboard.remember).toHaveBeenCalledWith(
        'https://cindy.app/s#slow',
        new Date(500_000).toISOString(),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not register or return a link when saving its approval watch fails', async () => {
    host.watch.mockRejectedValueOnce(new Error('[PRECONDITION_FAILED] approval setup failed'));
    const invoke = replying({ link: 'https://cindy.app/s#test', linkId: LINK_ID, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await expect(invokeProviderManagement(invoke, 'group-host', createLink)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(clipboard.remember).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('drops a watched request once it is approved or rejected here, but not when the group computer refused', async () => {
    await invokeProviderManagement(replying({ ok: true }), 'group-host', { action: 'manage-share', command: { action: 'approve', requestId: 'r1' } });
    await invokeProviderManagement(replying({ ok: true }), 'group-host', { action: 'manage-share', command: { action: 'reject', requestId: 'r2' } });
    expect(host.forget.mock.calls).toEqual([['r1'], ['r2']]);

    const refused = vi.fn(async () => ({ ok: false, error: { code: 'IPC_ERROR', message: '[NOT_FOUND] gone' } })) as unknown as ProviderGroupRemoteInvoke;
    await expect(invokeProviderManagement(refused, 'group-host', { action: 'manage-share', command: { action: 'approve', requestId: 'r3' } }))
      .rejects.toThrow('[NOT_FOUND] gone');
    expect(host.forget).toHaveBeenCalledTimes(2);
  });

  it('reports an old group computer as needing an update', async () => {
    const old = vi.fn(async () => ({ ok: false, error: { code: 'IPC_ERROR', message: '[INVALID_PARAMS] unknown provider group action' } })) as unknown as ProviderGroupRemoteInvoke;
    await expect(invokeProviderManagement(old, 'group-host', createLink)).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(host.watch).not.toHaveBeenCalled();
  });

  // 旧版组所在电脑不认识按天明细：明确拒绝成「需要更新」，管理页据此退回所有时间的合计，不重试。
  it('reports a share command an old group computer does not know as needing an update', async () => {
    const old = vi.fn(async () => ({ ok: false, error: { code: 'IPC_ERROR', message: '[INVALID_PARAMS] Unknown command' } })) as unknown as ProviderGroupRemoteInvoke;
    const request: ProviderManagementRequest = { action: 'manage-share', command: { action: 'usage-history', providerId: 'anthropic' } };
    await expect(invokeProviderManagement(old, 'group-host', request)).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(old).toHaveBeenCalledTimes(1);
  });

  it('forwards conditional writes and never retries a conflict or falls back to an unconditional old-host write', async () => {
    const request: ProviderManagementRequest = {
      action: 'manage-group', command: { action: 'delete-if-current', providerId: 'anthropic', expectedConfig: null },
    };
    const conflict = vi.fn(async () => ({ ok: false, error: { code: 'IPC_ERROR', message: '[PROVIDER_GROUP_CHANGED] changed' } })) as unknown as ProviderGroupRemoteInvoke;
    await expect(invokeProviderManagement(conflict, 'group-host', request)).rejects.toThrow('[PROVIDER_GROUP_CHANGED]');
    expect(conflict).toHaveBeenCalledExactlyOnceWith('group-host', PROVIDER_GROUP_REMOTE_CHANNEL, [request], expect.anything());
    const old = vi.fn(async () => ({ ok: false, error: { code: 'IPC_ERROR', message: '[INVALID_PARAMS] unknown provider group action' } })) as unknown as ProviderGroupRemoteInvoke;
    await expect(invokeProviderManagement(old, 'group-host', request)).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(old).toHaveBeenCalledTimes(1);
  });
});
