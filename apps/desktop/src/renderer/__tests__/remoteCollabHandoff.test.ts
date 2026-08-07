/**
 * remoteCollabHandoff:device-link 远程开启协同的收尾语义。
 *
 * 核心不变量(issue #1170 codex 两轮 P1):
 *  · 隧道超时**不是**权威失败 —— 超时只删掉控制端的等待项,被控端那次 enableOrca 仍在跑。
 *    把它当失败直接放行,会让「被控端起 Worker 慢了几秒」变成「用户明确开了协同,首轮却以
 *    普通单会话跑」。所以超时后要回查被控端 DB 的权威终态再定性。
 *  · 回查查不到就 fail-closed 抛原始超时,绝不把「没建成」猜成「建成了」。
 *  · 镜像回流始终 fire-and-forget,且排在定性之后。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshRemoteDeviceSessions = vi.fn().mockResolvedValue('ok');
vi.mock('@/features/device-link/refreshRemoteSessions', async (importOriginal) => ({
  // 只桩掉会真的发 IPC 的回流函数;瞬态判据用**真实实现** —— 回查的重试口径
  // 复用的就是 device-link 那份判据,桩一个等价物等于测了个假的。
  ...(await importOriginal<typeof import('@/features/device-link/refreshRemoteSessions')>()),
  refreshRemoteDeviceSessions: (...args: unknown[]) => refreshRemoteDeviceSessions(...args),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const enableOrca = vi.fn();
const listWorkersByLead = vi.fn();
const getCapabilities = vi.fn();
vi.mock('@/lib/makerTransport', () => ({
  agentCapabilitiesForDevice: (...a: unknown[]) => getCapabilities(...a),
  makerApiForDevice: () => ({ enableOrca: (...a: unknown[]) => enableOrca(...a) }),
  orcaWorkflowsForDevice: () => ({ listWorkersByLead: (...a: unknown[]) => listWorkersByLead(...a) }),
}));

import { enableRemoteCollabForSession } from '@/features/cc-agent/remoteCollabHandoff';

const params = {
  deviceId: 'dev-1',
  leadSessionId: 'lead-1',
  options: { workerAgent: 'codex' as const },
  logTag: 'test',
};

const timeoutError = () => new Error('[DEVICE_LINK_TIMEOUT] waiting for remote response');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  getCapabilities.mockResolvedValue({ supportsOrcaWorkerPermissionMode: true });
});

describe('enableRemoteCollabForSession', () => {
  it('真正 mutation 前重新确认被控端支持 Team Worker 权限模式', async () => {
    getCapabilities.mockResolvedValue({ supportsOrcaWorkerPermissionMode: false });

    await expect(enableRemoteCollabForSession(params)).rejects.toThrow(
      'DEVICE_LINK_CHANNEL_NOT_ALLOWED',
    );
    expect(getCapabilities).toHaveBeenCalledWith('dev-1', 'codex');
    expect(enableOrca).not.toHaveBeenCalled();
  });

  it('成功路径:回传 worker session,并 fire-and-forget 刷镜像', async () => {
    enableOrca.mockResolvedValue({ workerSessionId: 'worker-1' });

    await expect(enableRemoteCollabForSession(params)).resolves.toEqual({
      focusWorkerSessionId: 'worker-1',
    });
    expect(refreshRemoteDeviceSessions).toHaveBeenCalledWith('dev-1');
    // 成功路径不该去回查:enableOrca 返回即代表被控端 DB 已提交。
    expect(listWorkersByLead).not.toHaveBeenCalled();
  });

  it('权威失败(如 PRECONDITION_FAILED):原样抛出,不回查', async () => {
    enableOrca.mockRejectedValue(new Error('[PRECONDITION_FAILED] collaboration is disabled'));

    await expect(enableRemoteCollabForSession(params)).rejects.toThrow('PRECONDITION_FAILED');
    // 被控端明确拒绝了,回查毫无意义 —— 也不能因为回查恰好读到别的 team 就翻成成功。
    expect(listWorkersByLead).not.toHaveBeenCalled();
    expect(refreshRemoteDeviceSessions).toHaveBeenCalledWith('dev-1');
  });

  it('隧道超时 + 被控端其实已建成:回查到 worker 后照成功返回,不误报失败', async () => {
    enableOrca.mockRejectedValue(timeoutError());
    listWorkersByLead.mockResolvedValue([{ sessionId: 'worker-late', id: 'w1' }]);

    await expect(enableRemoteCollabForSession(params)).resolves.toEqual({
      focusWorkerSessionId: 'worker-late',
    });
    expect(listWorkersByLead).toHaveBeenCalledWith('lead-1');
  });

  it('隧道超时 + 被控端确实没建成:fail-closed 抛原始超时', async () => {
    enableOrca.mockRejectedValue(timeoutError());
    listWorkersByLead.mockResolvedValue([]);

    // 回查之间有真实退避。用 fake timers 快进,而不是让用例真睡满 —— 真睡会逼近
    // vitest 默认 5s 超时,在慢 runner 上变成 flake(本 PR 已被同类超时 flake 咬过一次)。
    vi.useFakeTimers();
    const pending = enableRemoteCollabForSession(params);
    const assertion = expect(pending).rejects.toThrow('DEVICE_LINK_TIMEOUT');
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    // 有限次回查后放弃,不无限等待(被控端可能永远不返回,无界等待会把首轮永久挂起)。
    expect(listWorkersByLead).toHaveBeenCalledTimes(6);
  });

  it('回查撞上瞬态错误:用完剩余重试预算,不因链路抖一下就判定没建成', async () => {
    // 触发回查的前提就是链路刚抖过(enableOrca 超时),第一次回查撞上同一段抖动是常态。
    // 头两次瞬态失败,第三次读到 worker —— 必须能恢复成功,不能在第一次就放弃。
    enableOrca.mockRejectedValue(timeoutError());
    listWorkersByLead
      .mockRejectedValueOnce(new Error('[DEVICE_LINK_NOT_CONNECTED] link down'))
      .mockRejectedValueOnce(new Error('[DEVICE_LINK_TIMEOUT] probe timed out'))
      .mockResolvedValue([{ sessionId: 'worker-late', id: 'w1' }]);

    vi.useFakeTimers();
    const pending = enableRemoteCollabForSession(params);
    const assertion = expect(pending).resolves.toEqual({ focusWorkerSessionId: 'worker-late' });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(listWorkersByLead).toHaveBeenCalledTimes(3);
  });

  it('探针自身黑洞时按总 deadline 收尾,不把 composer 锁上几分钟', async () => {
    // 链路「可连但每个 invoke 都黑洞」:每次回查自己要走满 30s 隧道超时。只限次数的话
    // 6 次串行 ≈ 3 分钟,而这段时间 composer 是锁住的、首轮压着不发(codex P2 第五轮)。
    enableOrca.mockRejectedValue(timeoutError());
    listWorkersByLead.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('[DEVICE_LINK_TIMEOUT] probe black-holed')), 30_000);
        }),
    );

    vi.useFakeTimers();
    const pending = enableRemoteCollabForSession(params);
    const assertion = expect(pending).rejects.toThrow('DEVICE_LINK_TIMEOUT');
    // 推进远超 6×(30s+3s) 的时间,确认它早就按 deadline 停了而不是跑满次数。
    await vi.advanceTimersByTimeAsync(200_000);
    await assertion;
    // 30s deadline 内只来得及发出一次探针(它自己就耗满 30s),第二轮进不去。
    expect(listWorkersByLead).toHaveBeenCalledTimes(1);
  });

  it('回查全程瞬态失败:预算用尽后仍 fail-closed 抛原始超时', async () => {
    enableOrca.mockRejectedValue(timeoutError());
    listWorkersByLead.mockRejectedValue(new Error('[DEVICE_LINK_NOT_CONNECTED] link down'));

    vi.useFakeTimers();
    const pending = enableRemoteCollabForSession(params);
    const assertion = expect(pending).rejects.toThrow('DEVICE_LINK_TIMEOUT');
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(listWorkersByLead).toHaveBeenCalledTimes(6);
  });

  it('回查撞上永久错误(老被控端没有该 channel):立即降级,不空转剩余轮次', async () => {
    enableOrca.mockRejectedValue(timeoutError());
    listWorkersByLead.mockRejectedValue(
      new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel not allowed'),
    );

    await expect(enableRemoteCollabForSession(params)).rejects.toThrow('DEVICE_LINK_TIMEOUT');
    // 重试多少次都是同一个结果,再等 18 秒毫无意义。
    expect(listWorkersByLead).toHaveBeenCalledTimes(1);
  });

  it('回查撞上未知错误:按不可重试处理,不空转', async () => {
    enableOrca.mockRejectedValue(timeoutError());
    listWorkersByLead.mockRejectedValue(new Error('something entirely unexpected'));

    await expect(enableRemoteCollabForSession(params)).rejects.toThrow('DEVICE_LINK_TIMEOUT');
    expect(listWorkersByLead).toHaveBeenCalledTimes(1);
  });

  it('镜像回流失败不影响返回值(fire-and-forget,不 await)', async () => {
    enableOrca.mockResolvedValue({ workerSessionId: 'worker-1' });
    refreshRemoteDeviceSessions.mockRejectedValueOnce(new Error('tunnel closed'));

    await expect(enableRemoteCollabForSession(params)).resolves.toEqual({
      focusWorkerSessionId: 'worker-1',
    });
  });
});
