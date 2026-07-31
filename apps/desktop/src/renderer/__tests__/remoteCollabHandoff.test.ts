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
vi.mock('@/features/device-link/refreshRemoteSessions', () => ({
  refreshRemoteDeviceSessions: (...args: unknown[]) => refreshRemoteDeviceSessions(...args),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const enableOrca = vi.fn();
const listWorkersByLead = vi.fn();
vi.mock('@/lib/makerTransport', () => ({
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
});

describe('enableRemoteCollabForSession', () => {
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

  it('回查本身失败(链路又抖 / 老被控端):不再猜,按超时降级', async () => {
    enableOrca.mockRejectedValue(timeoutError());
    listWorkersByLead.mockRejectedValue(new Error('[DEVICE_LINK_NOT_CONNECTED] link down'));

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
