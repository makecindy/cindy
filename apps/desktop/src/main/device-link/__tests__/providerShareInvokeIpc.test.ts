/**
 * 受邀者电脑上 Renderer 对分享来的供应商(`share:<id>`)的只读请求：只放行模型列表与发送前检查
 * 要读的几项，就绪只回是否装好 Agent，分享者电脑拒绝时给分享专属原因。
 */
import { DeviceLinkError } from '@cindy/device-link';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => '/tmp/cindy-share-ipc-test/app', getPath: () => '/tmp/cindy-share-ipc-test', getVersion: () => '0.0.0-test' },
  ipcMain: { handle: vi.fn() },
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
const warn = vi.hoisted(() => vi.fn());
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() }),
}));
const noteFailure = vi.hoisted(() => vi.fn());
vi.mock('../providerShareGuest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providerShareGuest.js')>()),
  resolveRemoteAgentTargetWhenReady: async () => 'host-peer',
  noteProviderShareAccessFailure: noteFailure,
}));
vi.mock('../providerShareCrossRegion.js', () => ({
  isCrossRegionProviderShareTarget: () => false,
  crossRegionInvoke: vi.fn(),
}));

import { handleProviderShareInvoke } from '../ipc';

const invoke = vi.fn();
const deps = { invoke } as unknown as Parameters<typeof handleProviderShareInvoke>[0];

beforeEach(() => {
  invoke.mockReset();
  noteFailure.mockReset();
});

describe('provider share renderer reads', () => {
  it('passes the picker and send-gate reads to the owner computer only', async () => {
    invoke.mockResolvedValue({ ok: true, result: ['claude-code'] });
    await expect(handleProviderShareInvoke(deps, 'share:s1', 'maker:list-available-agents', [])).resolves.toEqual(['claude-code']);
    invoke.mockResolvedValue({ ok: true, result: { availableModels: [] } });
    await expect(handleProviderShareInvoke(deps, 'share:s1', 'maker:get-capabilities', ['claude-code']))
      .resolves.toEqual({ availableModels: [] });
    expect(invoke).toHaveBeenLastCalledWith('host-peer', 'maker:get-capabilities', ['claude-code']);
    for (const channel of ['local-db:sessions:list', 'maker:model-favorites:get', undefined]) {
      await expect(handleProviderShareInvoke(deps, 'share:s1', channel, [])).rejects.toThrow(/DEVICE_LINK_CHANNEL_NOT_ALLOWED/);
    }
  });

  it('keeps only whether the agent is installed from the owner readiness', async () => {
    invoke.mockResolvedValue({ ok: true, result: { binaryReady: true, authReady: true, binaryPath: '/Users/alice/bin', identity: 'alice@corp.com' } });
    await expect(handleProviderShareInvoke(deps, 'share:s1', 'maker:agent:status', ['codex'])).resolves.toEqual({ binaryReady: true });
  });

  it('reads through the background link to the owner computer when it is wired in', async () => {
    // relay 只在建链时登记受邀者这台电脑:直接发 invoke 会被拒成 providerShare peer unavailable。
    const hostInvoke = vi.fn(async () => ({ ok: true as const, result: { providers: [] } }));
    await expect(handleProviderShareInvoke({ invoke, invokeProviderShareHost: hostInvoke }, 'share:s1', 'maker:provider:list', [{ capabilities: [] }]))
      .resolves.toEqual({ providers: [] });
    expect(hostInvoke).toHaveBeenCalledWith('host-peer', 'maker:provider:list', [{ capabilities: [] }]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('logs why a read failed, once a minute per error', async () => {
    warn.mockClear();
    invoke.mockResolvedValue({ ok: false, error: { code: 'DEVICE_OFFLINE', message: 'peer offline' } });
    for (let i = 0; i < 2; i++) {
      await expect(handleProviderShareInvoke(deps, 'share:s9', 'maker:provider:list', [])).rejects.toThrow();
    }
    const lines = warn.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('provider share read failed'));
    expect(lines).toEqual(['provider share read failed: maker:provider:list on share:s9: DEVICE_OFFLINE peer offline']);
  });

  it('scrubs the owner identity from the provider list', async () => {
    invoke.mockResolvedValue({ ok: true, result: { providers: [{ id: 'openai', name: 'OpenAI · alice@corp.com', openAiAccount: { identity: 'alice@corp.com' } }] } });
    const result = await handleProviderShareInvoke(deps, 'share:s1', 'maker:provider:list', []);
    expect(JSON.stringify(result)).not.toContain('alice');
  });

  it('turns a refusal by the owner computer into the share-specific reason', async () => {
    invoke.mockResolvedValue({ ok: false, error: { code: 'ACCESS_REVOKED', message: 'no' } });
    await expect(handleProviderShareInvoke(deps, 'share:s1', 'maker:get-capabilities', ['pi'])).rejects.toThrow(/REMOTE_AGENT_SHARE_UNAVAILABLE/);
    invoke.mockRejectedValue(new DeviceLinkError('REMOTE_DISABLED', 'remote control disabled'));
    await expect(handleProviderShareInvoke(deps, 'share:s1', 'maker:provider:list', [])).rejects.toThrow(/REMOTE_AGENT_SHARE_UNAVAILABLE/);
    expect(noteFailure).toHaveBeenCalledTimes(2);
  });
});
