import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), owner: vi.fn(() => 'owner'), pending: vi.fn(() => false), chain: vi.fn(() => 'chain'), linkEpoch: vi.fn(() => 0) }));
vi.mock('../../../device-link/index.js', () => ({ remoteBackgroundInvoke: mocks.invoke, remoteInvoke: mocks.invoke, getRemoteLinkCloseEpoch: mocks.linkEpoch }));
vi.mock('../../../appSessionState.js', () => ({ activeOwnerScopeKey: mocks.owner, isAppSessionBoundaryPending: mocks.pending }));
vi.mock('../../resolveAuxiliaryModelChain.js', () => ({ getEffectiveAuxiliaryModelChainSnapshot: mocks.chain }));

import { requestRemoteUtilityText } from '../client.js';

// 测试价值：公开入口 requestRemoteUtilityText 的设备路由、验证和取消结果；依据 remote utility
// 同账号设备路由与取消契约；host 测试不覆盖 client；最小输入为同名路由、无效响应和运行中取消。
// tier: unit（内存 RPC fake）；单文件实测墙钟 1.605s。新文件是独立 client 环境，不能并入 host。
const route = { deviceId: 'device-b', providerId: 'provider', agentKind: 'codex' as const, model: 'model' };
const exact = { providerId: route.providerId, agentKind: route.agentKind, model: route.model };
const caps = (allowedRoutes = [exact]) => ({ ok: true, result: { version: 1, op: 'caps', ok: true, hostEpoch: 'epoch', allowedRoutes } });
const success = (requestId: string, text = '  answer  ') => ({ ok: true, result: { version: 1, op: 'run', ok: true, requestId, result: { ok: true, text, providerId: 'provider', model: 'model', transport: 'codex-responses' } } });

beforeEach(() => { vi.clearAllMocks(); mocks.owner.mockReturnValue('owner'); mocks.pending.mockReturnValue(false); mocks.chain.mockReturnValue('chain'); mocks.linkEpoch.mockReturnValue(0); });

describe('remote utility client', () => {
  it('dispatches the exact route to the chosen device and returns validated text', async () => {
    mocks.invoke.mockImplementation(async (_device, _channel, [request], options) => {
      if (request.op === 'caps') return caps();
      options.preSend();
      return success(request.requestId);
    });
    const onText = vi.fn();
    const result = await requestRemoteUtilityText(route, 'prompt', { maxTokens: 12, validateResponse: text => text === 'answer', onText });
    expect(result).toMatchObject({ ok: true, text: 'answer' });
    expect(onText).toHaveBeenCalledWith('answer');
    expect(mocks.invoke.mock.calls[1]!.slice(0, 3)).toMatchObject(['device-b', expect.any(String), [{ op: 'run', hostEpoch: 'epoch', route: exact, prompt: 'prompt', options: { maxTokens: 12, disableReasoning: true } }]]);
  });

  it('does not dispatch a route absent from remote capabilities', async () => {
    mocks.invoke.mockResolvedValue(caps([]));
    expect(await requestRemoteUtilityText(route, 'prompt')).toMatchObject({ ok: false, reason: 'no_candidate' });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid returned text without delivering it', async () => {
    mocks.invoke.mockImplementation(async (_device, _channel, [request], options) => {
      if (request.op === 'caps') return caps();
      options.preSend();
      return success(request.requestId, 'wrong');
    });
    const onText = vi.fn();
    expect(await requestRemoteUtilityText(route, 'prompt', { validateResponse: () => false, onText })).toMatchObject({ ok: false, reason: 'all_candidates_failed' });
    expect(onText).not.toHaveBeenCalled();
  });

  it('does not send a queued run after the auxiliary chain snapshot changes', async () => {
    let queuedPreSend!: () => void;
    let failRun!: (error: Error) => void;
    let sent = false;
    // 测试价值：公开入口 requestRemoteUtilityText 在链路排队后复核辅助链快照；依据链编辑不得派发旧选择；
    // 现有用例不覆盖等待期间链变化；最小输入为 preSend 延迟到快照变化后；tier: unit。
    const queued = new Promise<void>((ready) => {
      mocks.invoke.mockImplementation((_device, _channel, [request], options) => {
        if (request.op === 'caps') return Promise.resolve(caps());
        return new Promise((_resolve, reject) => {
          failRun = reject;
          queuedPreSend = () => { options.preSend(); sent = true; };
          ready();
        });
      });
    });
    const pending = requestRemoteUtilityText(route, 'prompt');
    await queued;
    mocks.chain.mockReturnValue('edited');
    expect(queuedPreSend).toThrow('Request cancelled');
    expect(sent).toBe(false);
    failRun(new Error('send prevented'));
    expect(await pending).toMatchObject({ ok: false, reason: 'all_candidates_failed' });
  });

  it('cancels a submitted request on its original device and ignores its late result', async () => {
    let finish!: (value: unknown) => void;
    let submitted!: () => void;
    const ready = new Promise<void>(resolve => { submitted = resolve; });
    mocks.invoke.mockImplementation((_device, _channel, [request], options) => {
      if (request.op === 'caps') return Promise.resolve(caps());
      if (request.op === 'cancel') return Promise.resolve({ ok: true });
      options.preSend();
      submitted();
      return new Promise(resolve => { finish = resolve; });
    });
    const controller = new AbortController();
    const onText = vi.fn();
    const result = requestRemoteUtilityText(route, 'prompt', { signal: controller.signal, onText });
    await ready;
    const run = mocks.invoke.mock.calls[1]![2][0];
    controller.abort();
    expect(await result).toMatchObject({ ok: false, reason: 'timeout' });
    expect(mocks.invoke.mock.calls[2]!.slice(0, 3)).toMatchObject(['device-b', expect.any(String), [{ op: 'cancel', hostEpoch: 'epoch', requestId: run.requestId }]]);
    mocks.linkEpoch.mockReturnValue(1);
    expect(() => mocks.invoke.mock.calls[2]![3].preSend()).toThrow('Request no longer active');
    finish(success(run.requestId));
    await Promise.resolve();
    expect(onText).not.toHaveBeenCalled();
  });
});
