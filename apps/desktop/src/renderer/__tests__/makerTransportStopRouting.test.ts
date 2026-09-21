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
  const invoke = vi.fn().mockResolvedValue('stopped');
  vi.stubGlobal('window', {
    electronAPI: {
      maker: { stopAgentTask },
      deviceLink: { invoke },
    },
  });
  return { stopAgentTask, invoke };
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

describe('canStopAgentTask 门禁', () => {
  it('本机 / 远程已知设备 → 可停;远程但拿不到设备 → 不可停', async () => {
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

    // 连粘滞缓存也没有(完全查不到归属)= 本机判定 —— 与会话来源同一口径。
    __resetStickySessionOriginForTest();
    expect(canStopAgentTask('remote-1')).toBe(true);
  });
});
