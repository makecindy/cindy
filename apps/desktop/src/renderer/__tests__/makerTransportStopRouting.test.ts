/**
 * makerTransport 逐任务停止路由单测。
 *
 * 后台命令 / durable subagent 的进程属于**会话所在端**:控制端 main 没有那个 handle,
 * 本地 stopAgentTask 会「假成功」(控制端表里恰好有同 id 任务时还会停错对象),而被控端
 * 那条照旧在跑。因此远程镜像会话必须隧道到被控端执行,并且按**粘滞归属**路由 ——
 * relay 瞬断清空注册表的窗口里仍留在被控端。
 *
 * 这是手机版(纯控制端)复用同一套契约的回归保护。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

function stubElectron() {
  const stopAgentTask = vi.fn().mockResolvedValue('stopped');
  const listSessionBackgroundTasks = vi.fn().mockResolvedValue({ tasks: [] });
  const invoke = vi.fn().mockResolvedValue('stopped');
  vi.stubGlobal('window', {
    electronAPI: {
      maker: { stopAgentTask, listSessionBackgroundTasks },
      deviceLink: { invoke },
    },
  });
  return { stopAgentTask, listSessionBackgroundTasks, invoke };
}

const sess = (id: string): never => ({ id }) as never;

describe('stopAgentTaskFor 路由', () => {
  it('本机会话:直连本机 IPC,不碰隧道', async () => {
    const { stopAgentTask, invoke } = stubElectron();
    const { stopAgentTaskFor } = await import('@/lib/makerTransport');

    await stopAgentTaskFor('local-1', 'bash-1');

    expect(stopAgentTask).toHaveBeenCalledWith('local-1', 'bash-1');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('远程镜像会话:隧道到被控端(channel / args 与 preload 对齐)', async () => {
    const { stopAgentTask, invoke } = stubElectron();
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('remote-1')]);
    const { stopAgentTaskFor } = await import('@/lib/makerTransport');

    await stopAgentTaskFor('remote-1', 'bash-9');

    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:agent-task:stop', ['remote-1', 'bash-9']);
    expect(stopAgentTask).not.toHaveBeenCalled();
  });

  it('注册表瞬时清空(relay 重连)时仍留在被控端,不退回本机假成功', async () => {
    const { stopAgentTask, invoke } = stubElectron();
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    const { getStickySessionDeviceId } = await import(
      '@/features/device-link/stickySessionOrigin'
    );
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('remote-1')]);
    // 先解析一次:粘滞缓存是「查询时记入」,真实 UI 在注册表还在时就已经查过
    // (Stop gating / 水合都会查)。
    expect(getStickySessionDeviceId('remote-1')).toBe('dev-1');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', []);
    const { stopAgentTaskFor } = await import('@/lib/makerTransport');

    await stopAgentTaskFor('remote-1', 'bash-9');

    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:agent-task:stop', ['remote-1', 'bash-9']);
    expect(stopAgentTask).not.toHaveBeenCalled();
  });
});

describe('listSessionBackgroundTasksFor 路由', () => {
  it('本机会话走本地 IPC,远程镜像会话隧道到被控端(运行集信号不再在控制端关闭)', async () => {
    const { listSessionBackgroundTasks, invoke } = stubElectron();
    const { listSessionBackgroundTasksFor } = await import('@/lib/makerTransport');

    await listSessionBackgroundTasksFor('local-1');
    expect(listSessionBackgroundTasks).toHaveBeenCalledWith('local-1');
    expect(invoke).not.toHaveBeenCalled();

    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('remote-1')]);
    const snapshot = {
      tasks: [{ taskId: 'bash-9', taskType: 'local_bash', provider: 'pi' }],
      pendingContinuations: 0,
    };
    invoke.mockResolvedValue(snapshot);

    await expect(listSessionBackgroundTasksFor('remote-1')).resolves.toEqual(snapshot);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:session-background-tasks:list', [
      'remote-1',
    ]);
    expect(listSessionBackgroundTasks).toHaveBeenCalledTimes(1);
  });

  it('老被控端无该 channel / 隧道失败:降级空表,不透传异常(控制端保持现状不误报)', async () => {
    const { invoke } = stubElectron();
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('remote-2')]);
    invoke.mockRejectedValue(new Error('DEVICE_LINK_CHANNEL_NOT_ALLOWED'));
    const { listSessionBackgroundTasksFor } = await import('@/lib/makerTransport');

    await expect(listSessionBackgroundTasksFor('remote-2')).resolves.toEqual({ tasks: [] });
  });
});

describe('canStopAgentTask 门禁', () => {
  it('本机 / 远程已知设备 → 可停;归属不可解析 → 不可停', async () => {
    stubElectron();
    const { canStopAgentTask } = await import('@/lib/makerTransport');
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    const { __resetStickySessionOriginForTest } = await import(
      '@/features/device-link/stickySessionOrigin'
    );

    expect(canStopAgentTask(null)).toBe(false);
    expect(canStopAgentTask('local-1')).toBe(true);

    // 远程镜像会话:这是本次修复的目标 —— 以前这里恒为 false(按钮被藏)。
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', [sess('remote-1')]);
    expect(canStopAgentTask('remote-1')).toBe(true);

    // relay 瞬断清空注册表:粘滞归属仍在 → 按钮保留(点击经隧道打到被控端)。
    remoteProjectsStore.setDeviceSessions('dev-1', 'Mac', []);
    expect(canStopAgentTask('remote-1')).toBe(true);

    // 连粘滞缓存也没有、也没有镜像来源证据 = 本机判定 —— 与会话来源同一口径。
    __resetStickySessionOriginForTest();
    expect(canStopAgentTask('remote-1')).toBe(true);

    // 一旦有镜像来源证据(受保护镜像读记下的 owner token),同一会话立刻变成「不可停」:
    // 归属不可解析时不允许回退本机(见上一个 describe 的用例)。
    const { __testing } = await import('@/features/device-link/mirrorCacheClient');
    __testing.rememberOwnerTokenForTest('remote-1', 'owner-token-2');
    expect(canStopAgentTask('remote-1')).toBe(false);
  });
});

describe('镜像来源但归属不可解析(第三状态)', () => {
  it('门禁返回 false,且停止拒绝而不是回退本机假成功', async () => {
    const { stopAgentTask, invoke } = stubElectron();
    const { __testing } = await import('@/features/device-link/mirrorCacheClient');
    // 真实路径由 device-link 受保护镜像读(readCachedMessages)记入;本机会话永不经过那条路。
    __testing.rememberOwnerTokenForTest('mirror-1', 'owner-token-1');
    const { canStopAgentTask, stopAgentTaskFor } = await import('@/lib/makerTransport');

    expect(canStopAgentTask('mirror-1')).toBe(false);
    await expect(stopAgentTaskFor('mirror-1', 'bash-1')).rejects.toThrow(/REMOTE_ORIGIN_UNKNOWN/);
    // 关键:绝不回退本机 —— 控制端 main 对不属于自己的会话会「幂等成功」,那是假成功。
    expect(stopAgentTask).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
