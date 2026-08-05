/**
 * goal / learn 传输层路由单测(makerTransportRouting 同范式):
 *   - device-link 远程会话 → deviceLink.invoke(deviceId, '<channel>', args)
 *   - 本机会话 → window.electronAPI.maker.* / window.electronAPI.learn.*
 * 附 drift 守卫:两个适配器用到的每个 channel 串都必须在 REMOTE_INVOKE_ALLOWLIST /
 * PUSH_FORWARD_ALLOWLIST 内,防止「适配器加了 channel、白名单忘了加」的静默 CHANNEL_NOT_ALLOWED。
 * 这是手机版(纯控制端)将要复用的同一套 channel/args 契约的回归保护。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_INVOKE_ALLOWLIST, PUSH_FORWARD_ALLOWLIST } from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';

beforeEach(() => {
  vi.resetModules();
});

async function primeOwnerFence(): Promise<void> {
  const { __testing: dataOwnerGenerationTesting, setDataOwnerGeneration } =
    await import('@/contexts/dataOwnerGeneration');
  const { __testing: remoteDataOwnerPushFenceTesting } =
    await import('@/lib/remoteDataOwnerPushFence');
  dataOwnerGenerationTesting.reset();
  remoteDataOwnerPushFenceTesting.reset();
  setDataOwnerGeneration('owner-a', 1);
}

const GOAL_TUNNEL_CHANNELS = [
  'maker:goal:set',
  'maker:goal:clear',
  'maker:goal:pause',
  'maker:goal:resume',
  'maker:goal:update',
  'maker:goal:get-status',
];
const LEARN_TUNNEL_CHANNELS = [
  'learn:start',
  'learn:list-runs',
  'learn:get-proposal-diff',
  'learn:apply',
  'learn:discard',
  'learn:cancel',
];

function stubElectron() {
  const makerSpies = {
    setGoal: vi.fn(),
    clearGoal: vi.fn(),
    pauseGoal: vi.fn(),
    resumeGoal: vi.fn(),
    updateGoal: vi.fn(),
    getGoalStatus: vi.fn(),
    onGoalStatusChanged: vi.fn(() => () => {}),
  };
  const learnSpies = {
    listRuns: vi.fn(),
    getProposalDiff: vi.fn(),
    apply: vi.fn(),
    discard: vi.fn(),
    cancel: vi.fn(),
    onEvent: vi.fn(() => () => {}),
  };
  const invoke = vi.fn().mockResolvedValue(undefined);
  const remotePushListeners: Array<(p: { deviceId: string; channel: string; payload: unknown }) => void> = [];
  const onRemotePush = vi.fn(
    (cb: (p: { deviceId: string; channel: string; payload: unknown }) => void) => {
      remotePushListeners.push(cb);
      return () => {};
    },
  );
  vi.stubGlobal('window', {
    electronAPI: { maker: makerSpies, learn: learnSpies, deviceLink: { invoke, onRemotePush } },
  });
  return { makerSpies, learnSpies, invoke, onRemotePush, remotePushListeners };
}

const sess = (id: string): Session => ({ id }) as unknown as Session;

describe('goalApiFor 路由', () => {
  it('远程会话:每个 goal 操作命中对应隧道 channel(updateGoal 打包 {sessionId,patch})', async () => {
    const { invoke, makerSpies } = stubElectron();
    const { goalApiFor } = await import('@/lib/makerTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('rs')]);

    const api = goalApiFor('rs');
    api.setGoal({ sessionId: 'rs', objective: 'o' });
    api.clearGoal('rs');
    api.pauseGoal('rs');
    api.resumeGoal('rs');
    api.updateGoal('rs', { objective: 'o2' });
    api.getGoalStatus('rs');

    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:goal:set', [{ sessionId: 'rs', objective: 'o' }]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:goal:clear', ['rs']);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:goal:pause', ['rs']);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:goal:resume', ['rs']);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:goal:update', [
      { sessionId: 'rs', patch: { objective: 'o2' } },
    ]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:goal:get-status', ['rs']);
    expect(makerSpies.setGoal).not.toHaveBeenCalled();
  });

  it('本机会话:直通 window.electronAPI.maker,不碰隧道', async () => {
    const { invoke, makerSpies } = stubElectron();
    const { goalApiFor } = await import('@/lib/makerTransport');
    const api = goalApiFor('ls');
    api.setGoal({ sessionId: 'ls', objective: 'o' });
    api.getGoalStatus('ls');
    expect(makerSpies.setGoal).toHaveBeenCalled();
    expect(makerSpies.getGoalStatus).toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('subscribeGoalStatusChanged:远程走 onRemotePush 并按 deviceId+sessionId 过滤', async () => {
    const { onRemotePush, makerSpies, remotePushListeners } = stubElectron();
    const { subscribeGoalStatusChanged } = await import('@/lib/makerTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    await primeOwnerFence();
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('rs')]);

    const cb = vi.fn();
    subscribeGoalStatusChanged('rs', cb);
    expect(onRemotePush).toHaveBeenCalledTimes(1);
    expect(makerSpies.onGoalStatusChanged).not.toHaveBeenCalled();
    const listener = remotePushListeners[0];
    // 其它设备 / 其它 channel / 其它会话都不触发
    listener({ deviceId: 'dev-2', channel: 'maker:goal:status-changed', payload: { sessionId: 'rs', goal: null } });
    listener({ deviceId: 'dev-1', channel: 'maker:event', payload: { sessionId: 'rs' } });
    listener({ deviceId: 'dev-1', channel: 'maker:goal:status-changed', payload: { sessionId: 'other', goal: null } });
    expect(cb).not.toHaveBeenCalled();
    listener({ deviceId: 'dev-1', channel: 'maker:goal:status-changed', payload: { sessionId: 'rs', goal: null } });
    expect(cb).toHaveBeenCalledWith({ sessionId: 'rs', goal: null });
  });
});

describe('learnApiFor 路由', () => {
  it('远程上下文:每个 learn 操作命中对应隧道 channel', async () => {
    const { invoke, learnSpies } = stubElectron();
    const { learnApiFor } = await import('@/features/learn/learnTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('rs')]);

    const api = learnApiFor('rs');
    api.listRuns();
    api.getProposalDiff({ runId: 'r1' });
    api.apply({ runId: 'r1' });
    api.discard({ runId: 'r1' });
    api.cancel({ runId: 'r1' });

    expect(invoke).toHaveBeenCalledWith('dev-1', 'learn:list-runs', []);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'learn:get-proposal-diff', [{ runId: 'r1' }]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'learn:apply', [{ runId: 'r1' }]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'learn:discard', [{ runId: 'r1' }]);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'learn:cancel', [{ runId: 'r1' }]);
    expect(learnSpies.listRuns).not.toHaveBeenCalled();
  });

  it('本机上下文(含 undefined):直通 window.electronAPI.learn', async () => {
    const { invoke, learnSpies } = stubElectron();
    const { learnApiFor } = await import('@/features/learn/learnTransport');
    learnApiFor('ls').listRuns();
    learnApiFor(undefined).cancel({ runId: 'r1' });
    expect(learnSpies.listRuns).toHaveBeenCalled();
    expect(learnSpies.cancel).toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('subscribeLearnEvents:远程走 onRemotePush 并按 deviceId+channel 过滤', async () => {
    const { learnSpies, remotePushListeners } = stubElectron();
    const { subscribeLearnEvents } = await import('@/features/learn/learnTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    await primeOwnerFence();
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('rs')]);

    const cb = vi.fn();
    subscribeLearnEvents('rs', cb);
    expect(learnSpies.onEvent).not.toHaveBeenCalled();
    const listener = remotePushListeners[0];
    listener({ deviceId: 'dev-2', channel: 'learn:event', payload: { type: 'state-changed' } });
    listener({ deviceId: 'dev-1', channel: 'maker:event', payload: {} });
    expect(cb).not.toHaveBeenCalled();
    const evt = { type: 'state-changed', run: { runId: 'r1' } };
    listener({ deviceId: 'dev-1', channel: 'learn:event', payload: evt });
    expect(cb).toHaveBeenCalledWith(evt);
  });

  it('subscribeLearnEvents:本机上下文走本机 learn:event fan-out', async () => {
    const { onRemotePush, learnSpies } = stubElectron();
    const { subscribeLearnEvents } = await import('@/features/learn/learnTransport');
    subscribeLearnEvents('ls', vi.fn());
    expect(learnSpies.onEvent).toHaveBeenCalledTimes(1);
    expect(onRemotePush).not.toHaveBeenCalled();
  });
});

describe('origin 注入竞态(Codex review #548 回归)', () => {
  it('learnApiFor 惰性解析:先构造适配器、后注册 origin,调用仍路由到隧道', async () => {
    const { invoke, learnSpies } = stubElectron();
    const { learnApiFor } = await import('@/features/learn/learnTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');

    const api = learnApiFor('rs'); // 此刻 origin 尚未注册
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('rs')]); // 异步重拉完成,origin 注入
    api.cancel({ runId: 'r1' });
    expect(invoke).toHaveBeenCalledWith('dev-1', 'learn:cancel', [{ runId: 'r1' }]);
    expect(learnSpies.cancel).not.toHaveBeenCalled();
  });

  it('subscribeLearnEvents:订阅后 origin 注入 → 自动从本机重绑到远程推送', async () => {
    const { learnSpies, remotePushListeners } = stubElectron();
    const { subscribeLearnEvents } = await import('@/features/learn/learnTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    await primeOwnerFence();

    const cb = vi.fn();
    subscribeLearnEvents('rs', cb); // origin 未注册 → 先绑本机
    expect(learnSpies.onEvent).toHaveBeenCalledTimes(1);
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('rs')]); // 注入 → 重绑
    expect(remotePushListeners.length).toBe(1);
    const evt = { type: 'state-changed', run: { runId: 'r1' } };
    remotePushListeners[0]({ deviceId: 'dev-1', channel: 'learn:event', payload: evt });
    expect(cb).toHaveBeenCalledWith(evt);
  });

  it('goalApiFor 粘滞:解析到过 deviceId 后,镜像被清(relay 重连)也不降级回本机', async () => {
    const { invoke, makerSpies } = stubElectron();
    const { goalApiFor } = await import('@/lib/makerTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('rs')]);

    const api = goalApiFor('rs');
    api.pauseGoal('rs'); // 解析并粘滞 dev-1
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', []); // 模拟镜像清空(会话 origin 丢失)
    api.resumeGoal('rs'); // 粘滞值兜底,仍走隧道
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:goal:pause', ['rs']);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:goal:resume', ['rs']);
    expect(makerSpies.resumeGoal).not.toHaveBeenCalled();
  });
});

describe('listActiveRunsForSession 远程失败分类(终态 vs 瞬态)', () => {
  it('老被控端 CHANNEL_NOT_ALLOWED → ready:true 空 runs(终态,不触发调用方有界重试)', async () => {
    const { invoke } = stubElectron();
    // Electron 包装后 renderer 实际看到的 message 形态(extractIpcError 靠 ": Error: " 前缀解码)
    invoke.mockRejectedValue(
      new Error(
        "Error invoking remote method 'device-link:invoke': Error: [DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel 'learn:list-runs' not allowed remotely",
      ),
    );
    const { listActiveRunsForSession } = await import('@/features/learn/useLearnRun');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('rs')]);
    await expect(listActiveRunsForSession('rs')).resolves.toEqual({ ready: true, runs: [] });
  });

  it('其它隧道失败(离线/超时等)→ ready:false(瞬态,调用方按未就绪继续重试)', async () => {
    const { invoke } = stubElectron();
    invoke.mockRejectedValue(new Error('[DEVICE_LINK_TIMEOUT] invoke timed out'));
    const { listActiveRunsForSession } = await import('@/features/learn/useLearnRun');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('rs')]);
    await expect(listActiveRunsForSession('rs')).resolves.toEqual({ ready: false, runs: [] });
  });
});

describe('drift 守卫:适配器 channel 必须在协议白名单内', () => {
  it('goal / learn 隧道 invoke channel 全部在 REMOTE_INVOKE_ALLOWLIST', () => {
    for (const ch of [...GOAL_TUNNEL_CHANNELS, ...LEARN_TUNNEL_CHANNELS, 'desktop-cmd:run']) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch), `${ch} 不在 REMOTE_INVOKE_ALLOWLIST`).toBe(true);
    }
  });

  it('goal / learn 推送 channel 全部在 PUSH_FORWARD_ALLOWLIST', () => {
    for (const ch of ['maker:goal:status-changed', 'learn:event']) {
      expect(PUSH_FORWARD_ALLOWLIST.has(ch), `${ch} 不在 PUSH_FORWARD_ALLOWLIST`).toBe(true);
    }
  });
});
