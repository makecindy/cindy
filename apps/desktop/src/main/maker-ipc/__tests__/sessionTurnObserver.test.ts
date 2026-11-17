import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  verdict: vi.fn(),
  provider: vi.fn<(sessionId: string) => string | null>(),
  ensureLlama: vi.fn(async () => undefined),
  preparePermission: vi.fn(async () => () => {}),
}));

vi.mock('../../maker-host/model-route-guard-live.js', () => ({ verdictForModelRoute: h.verdict }));
vi.mock('../../maker-host/session-provider-store.js', () => ({ getSessionProvider: h.provider }));
vi.mock('../../local-model-runtime/preflight.js', () => ({ ensureManagedOllamaReadyForSession: h.ensureLlama }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ debug: vi.fn() }) }));
vi.mock('../botPermissionDispatch.js', () => ({ prepareBotPermissionDispatch: h.preparePermission }));

import type { Session } from '@cindy/maker-core';
import { MANAGED_LLAMACPP_PROVIDER_ID } from '../../../shared/llamaCpp.js';
import { MANAGED_OLLAMA_PROVIDER_ID } from '../../../shared/localModelRuntime.js';
import { installSessionTurnObserver } from '../sessionTurnObserver.js';

type Observer = { beforeProviderStart: (turnGeneration: number) => Promise<void>; onDispatching?: () => void };

function setup(fields: { remoteHostId?: string | null; agentDeviceId?: string | null }) {
  let observer: Observer | null = null;
  const session = {
    id: 's1',
    instanceId: 'i1',
    agentKind: 'pi',
    model: 'some-model',
    workDir: '/work',
    remoteHostId: fields.remoteHostId ?? null,
    agentDeviceId: fields.agentDeviceId ?? null,
    setTurnLifecycleObserver: (next: Observer | null) => { observer = next; },
    claimHostTurnContinuation: vi.fn(),
    getCurrentTurnOrigin: () => null,
  } as unknown as Session;
  const deps = {
    beforeLocalProviderStart: vi.fn(async () => undefined),
    silentStopTurnLeaseGate: { supersede: vi.fn(), schedule: vi.fn(), supersedeOwnedBy: vi.fn() },
    sessionTurnLeaseTracker: { markTurnStarted: vi.fn(async () => undefined), markTurnEnded: vi.fn(async () => undefined) },
    providerTurnLeaseId: (instanceId: string, generation: number) => `${instanceId}:${generation}`,
    log: { debug: vi.fn() },
  };
  installSessionTurnObserver(deps, session);
  return { deps, start: () => observer!.beforeProviderStart(1), dispatch: () => observer!.onDispatching?.() };
}

describe('installSessionTurnObserver provider precheck', () => {
  beforeEach(() => {
    h.verdict.mockReset();
    h.provider.mockReset();
    h.ensureLlama.mockClear();
    h.preparePermission.mockReset().mockResolvedValue(() => {});
    h.verdict.mockResolvedValue({ kind: 'reject', reason: 'explicit-source-unavailable' });
    h.provider.mockReturnValue('magpie-2e446a11');
  });

  // The common observer covers direct Desktop, IM and internal Session.send;
  // preparation success cannot suppress its final permission authorization.
  it('checks captured Bot permissions again at the synchronous provider boundary', async () => {
    let current = true;
    h.preparePermission.mockResolvedValue(() => { if (!current) throw new Error('permission changed'); });
    h.verdict.mockResolvedValue({ kind: 'pass' });
    const { start, dispatch } = setup({});
    await start();
    expect(() => dispatch()).not.toThrow();
    current = false;
    expect(() => dispatch()).toThrow('permission changed');
  });

  it('still rejects a local session whose explicit source is gone from this computer', async () => {
    const { deps, start } = setup({});
    await expect(start()).rejects.toMatchObject({ message: expect.stringContaining('magpie-2e446a11') });
    expect(h.verdict).toHaveBeenCalledWith('pi', 'some-model', 'magpie-2e446a11');
    expect(deps.sessionTurnLeaseTracker.markTurnStarted).not.toHaveBeenCalled();
  });

  it('does not treat a source missing from this computer as gone when the Agent runs elsewhere', async () => {
    for (const agentDeviceId of ['share:abc', 'device-2']) {
      h.verdict.mockClear();
      const { deps, start } = setup({ agentDeviceId });
      await expect(start()).resolves.toBeUndefined();
      expect(h.verdict).toHaveBeenCalledWith('pi', 'some-model', 'magpie-2e446a11');
      expect(deps.beforeLocalProviderStart).toHaveBeenCalledTimes(1);
      expect(deps.silentStopTurnLeaseGate.supersede).toHaveBeenCalledWith('s1');
      expect(deps.sessionTurnLeaseTracker.markTurnStarted).toHaveBeenCalledWith('s1', 'i1:1');
    }
  });

  it('keeps the paid-model gate for an Agent on your own other computer', async () => {
    // 同账号另一台电脑仍由同一账号付费：本机 requires_payment 的记账主体就是这个账号，
    // 门禁照常执行，不能借远端 Agent 绕开本账号的付费裁决。
    h.verdict.mockResolvedValue({ kind: 'reject', reason: 'payment-required' });
    const rejected = setup({ agentDeviceId: 'device-2' });
    await expect(rejected.start()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(rejected.deps.sessionTurnLeaseTracker.markTurnStarted).not.toHaveBeenCalled();
    h.verdict.mockResolvedValue({ kind: 'reroute', providerId: 'paid', reason: 'payment-required' });
    const rerouted = setup({ agentDeviceId: 'device-2' });
    await expect(rerouted.start()).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('lets a shared-provider run send even when this account marks the model requires_payment', async () => {
    // 回归（PR #5689 review）：受邀者（免费账号）使用分享者的付费订阅供应商时，受邀者本机目录
    // 把同名模型标为 requires_payment；请求记在分享者账上，不得用受邀者自己的标记拦发送。
    for (const verdict of [
      { kind: 'reject', reason: 'payment-required' },
      { kind: 'reroute', providerId: 'paid', reason: 'payment-required' },
    ]) {
      h.verdict.mockClear();
      h.verdict.mockResolvedValue(verdict);
      const { deps, start } = setup({ agentDeviceId: 'share:abc' });
      await expect(start()).resolves.toBeUndefined();
      expect(deps.sessionTurnLeaseTracker.markTurnStarted).toHaveBeenCalledWith('s1', 'i1:1');
    }
  });

  it("does not start this computer's managed llama.cpp for an Agent on another computer", async () => {
    h.provider.mockReturnValue(MANAGED_LLAMACPP_PROVIDER_ID);
    const remote = setup({ agentDeviceId: 'device-2' });
    await remote.start();
    expect(h.ensureLlama).not.toHaveBeenCalled();
    h.verdict.mockResolvedValue({ kind: 'pass' });
    const local = setup({});
    await local.start();
    expect(h.ensureLlama).toHaveBeenCalledTimes(1);
    expect(h.ensureLlama).toHaveBeenCalledWith({ providerId: MANAGED_LLAMACPP_PROVIDER_ID, onlyIfStopped: true, signal: undefined });
  });

  it('starts the managed Ollama sidecar for an existing local session turn', async () => {
    // 既有 ollama 会话在 sidecar 停止（如系统升级重启）后，发送必须先过就绪边界，
    // 与新建会话的 admitLocalRoute 同一契约。
    h.provider.mockReturnValue(MANAGED_OLLAMA_PROVIDER_ID);
    h.verdict.mockResolvedValue({ kind: 'pass' });
    const { deps, start } = setup({});
    await start();
    expect(h.ensureLlama).toHaveBeenCalledTimes(1);
    expect(h.ensureLlama).toHaveBeenCalledWith({ providerId: MANAGED_OLLAMA_PROVIDER_ID, onlyIfStopped: true, signal: undefined });
    expect(deps.sessionTurnLeaseTracker.markTurnStarted).toHaveBeenCalledWith('s1', 'i1:1');
  });

  it("does not start this computer's managed Ollama for an Agent on another computer", async () => {
    h.provider.mockReturnValue(MANAGED_OLLAMA_PROVIDER_ID);
    const remote = setup({ agentDeviceId: 'device-2' });
    await remote.start();
    expect(h.ensureLlama).not.toHaveBeenCalled();
    expect(remote.deps.sessionTurnLeaseTracker.markTurnStarted).toHaveBeenCalledWith('s1', 'i1:1');
  });

  it('does not touch the managed sidecar for an unrelated provider', async () => {
    // beforeEach 默认 provider 是非托管的 magpie-…；托管守卫不得越界触发。
    h.verdict.mockResolvedValue({ kind: 'pass' });
    const { start } = setup({});
    await start();
    expect(h.ensureLlama).not.toHaveBeenCalled();
  });

  it('aborts the turn before lease start when the managed sidecar restore fails', async () => {
    h.provider.mockReturnValue(MANAGED_OLLAMA_PROVIDER_ID);
    h.verdict.mockResolvedValue({ kind: 'pass' });
    h.ensureLlama.mockRejectedValueOnce(
      new Error('[LOCAL_OLLAMA_NOT_READY] Local model service is not ready (absent). Open Settings → Model Providers → Ollama.'),
    );
    const { deps, start } = setup({});
    await expect(start()).rejects.toMatchObject({
      message: expect.stringContaining('LOCAL_OLLAMA_NOT_READY'),
    });
    expect(deps.sessionTurnLeaseTracker.markTurnStarted).not.toHaveBeenCalled();
    expect(deps.silentStopTurnLeaseGate.supersede).not.toHaveBeenCalled();
  });

  it('keeps the SSH early return unchanged', async () => {
    const { deps, start } = setup({ remoteHostId: 'ssh-host' });
    await start();
    expect(h.verdict).not.toHaveBeenCalled();
    expect(deps.beforeLocalProviderStart).not.toHaveBeenCalled();
    expect(deps.sessionTurnLeaseTracker.markTurnStarted).not.toHaveBeenCalled();
  });
});
