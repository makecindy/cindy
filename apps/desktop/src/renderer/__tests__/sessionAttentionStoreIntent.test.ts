// @vitest-environment jsdom
/**
 * sessionAttentionStore 的 intent 语义:被动清除(默认)不允许吞掉 'error' 红角标,
 * 显式清除(explicit)可清任何 kind,并把 intent 随 IPC 桥接给 main。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addSessionAttention,
  applyMainSessionAttentionCleared,
  clearSessionAttention,
  clearSessionAttentionMany,
  clearSystemSessionAttention,
  getSessionAttentionKind,
  hasSessionAttention,
  noteRemoteSessionSyncCompleted,
  noteRemoteSessionSyncStarted,
  setRemoteReceiptDisplayReady,
  setRemoteTerminalErrorProbe,
} from '@/lib/sessionAttentionStore';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  applyRemoteSessionActivity,
  removeRemoteSessionActivityEntry,
} from '@/features/device-link/remoteSessionActivityStore';

const ipcClearMock = vi.fn(() => Promise.resolve());
const ipcMarkMock = vi.fn(() => Promise.resolve());
const deviceLinkInvokeMock = vi.fn(() => Promise.resolve());

describe('sessionAttentionStore clear intents', () => {
  beforeEach(() => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      notificationClearSessionAttention: ipcClearMock,
      notificationMarkSessionAttention: ipcMarkMock,
      deviceLink: { invoke: deviceLinkInvokeMock },
    };
  });

  afterEach(() => {
    // store 是模块级单例:清干净测试残留(explicit 保证连 error 一起清)。
    clearSessionAttentionMany(['s1', 's2', 's3', 'rs1'], { intent: 'explicit' });
    remoteProjectsStore.setDeviceSessions('dev1', 'Dev', []);
    vi.clearAllMocks();
  });

  it('passive clear (default) refuses to remove an error badge and sends no IPC', () => {
    addSessionAttention('s1', 'error');
    ipcMarkMock.mockClear();

    expect(clearSessionAttention('s1')).toBe(false);
    expect(hasSessionAttention('s1')).toBe(true);
    expect(getSessionAttentionKind('s1')).toBe('error');
    expect(ipcClearMock).not.toHaveBeenCalled();
  });

  it('passive clear still removes done/awaiting badges and bridges a passive IPC', () => {
    addSessionAttention('s1', 'done');

    expect(clearSessionAttention('s1')).toBe(true);
    expect(hasSessionAttention('s1')).toBe(false);
    expect(ipcClearMock).toHaveBeenCalledWith('s1', 'passive');
  });

  it('explicit clear removes an error badge and bridges an explicit IPC', () => {
    addSessionAttention('s1', 'error');

    expect(clearSessionAttention('s1', { intent: 'explicit' })).toBe(true);
    expect(hasSessionAttention('s1')).toBe(false);
    expect(ipcClearMock).toHaveBeenCalledWith('s1', 'explicit');
  });

  it('explicit clear bridges the IPC even when there is no local badge entry (renderer reload)', () => {
    // renderer 重载后本地 map 为空,但灵动岛可能仍挂着未读 error:
    // explicit 清除(处置横幅 / 全部标为已读 / pending-alerts 派生收敛)必须照发桥接。
    expect(hasSessionAttention('s1')).toBe(false);

    expect(clearSessionAttention('s1', { intent: 'explicit' })).toBe(false);
    expect(ipcClearMock).toHaveBeenCalledWith('s1', 'explicit');

    ipcClearMock.mockClear();
    expect(clearSessionAttentionMany(['s1', 's2'], { intent: 'explicit' })).toBe(0);
    expect(ipcClearMock).toHaveBeenCalledWith('s1', 'explicit');
    expect(ipcClearMock).toHaveBeenCalledWith('s2', 'explicit');
  });

  it('passive clear with no local entry stays silent (no IPC)', () => {
    expect(clearSessionAttention('s-none')).toBe(false);
    expect(ipcClearMock).not.toHaveBeenCalled();
  });

  it('clearSessionAttentionMany skips error badges when passive and clears them when explicit', () => {
    addSessionAttention('s1', 'done');
    addSessionAttention('s2', 'error');
    addSessionAttention('s3', 'awaiting');

    expect(clearSessionAttentionMany(['s1', 's2', 's3'])).toBe(2);
    expect(hasSessionAttention('s2')).toBe(true);

    expect(clearSessionAttentionMany(['s2'], { intent: 'explicit' })).toBe(1);
    expect(hasSessionAttention('s2')).toBe(false);
  });
});

describe('main 广播的会话已读消费(applyMainSessionAttentionCleared)', () => {
  beforeEach(() => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      notificationClearSessionAttention: ipcClearMock,
      notificationMarkSessionAttention: ipcMarkMock,
      deviceLink: { invoke: deviceLinkInvokeMock },
    };
  });

  afterEach(() => {
    clearSessionAttentionMany(['s1'], { intent: 'explicit' });
    vi.clearAllMocks();
  });

  it('removes the local badge without bridging IPC back (no echo loop)', () => {
    addSessionAttention('s1', 'done');
    ipcClearMock.mockClear();
    deviceLinkInvokeMock.mockClear();

    applyMainSessionAttentionCleared('s1', 'passive');

    expect(hasSessionAttention('s1')).toBe(false);
    expect(ipcClearMock).not.toHaveBeenCalled();
    expect(deviceLinkInvokeMock).not.toHaveBeenCalled();
  });

  it('passive push keeps error badges (double-layer immunity with main)', () => {
    addSessionAttention('s1', 'error');

    applyMainSessionAttentionCleared('s1', 'passive');
    expect(hasSessionAttention('s1')).toBe(true);

    applyMainSessionAttentionCleared('s1', 'explicit');
    expect(hasSessionAttention('s1')).toBe(false);
  });
});

describe('clearSystemSessionAttention 的远程路由', () => {
  beforeEach(() => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      notificationClearSessionAttention: ipcClearMock,
      notificationMarkSessionAttention: ipcMarkMock,
      deviceLink: { invoke: deviceLinkInvokeMock },
    };
  });

  afterEach(() => {
    // ready + 一轮完整 sync 把测试残留的挂起回执冲干净(mock 吞掉),再收回 ready,
    // 保证模块级单例状态不跨用例泄漏(代数计数跨用例递增无妨,逻辑只看相对值)。
    setRemoteReceiptDisplayReady('rs1', true);
    noteRemoteSessionSyncCompleted('rs1', noteRemoteSessionSyncStarted('rs1'));
    setRemoteReceiptDisplayReady('rs1', false);
    remoteProjectsStore.setDeviceSessions('dev1', 'Dev', []);
    vi.clearAllMocks();
  });

  const seedRemote = () => {
    remoteProjectsStore.setDeviceSessions('dev1', 'Dev', [
      { id: 'rs1' } as never,
    ]);
  };

  it('local sessions only bridge the local IPC', () => {
    clearSystemSessionAttention('local-s', 'passive');

    expect(ipcClearMock).toHaveBeenCalledWith('local-s', 'passive');
    expect(deviceLinkInvokeMock).not.toHaveBeenCalled();
  });

  it('holds a passive receipt until a sync that started after the enqueue completes', () => {
    seedRemote();
    setRemoteReceiptDisplayReady('rs1', true);

    clearSystemSessionAttention('rs1', 'passive');
    // 入队后尚无新 sync:本地 IPC 照发,远程腿不发。
    expect(ipcClearMock).toHaveBeenCalledWith('rs1', 'passive');
    expect(deviceLinkInvokeMock).not.toHaveBeenCalled();

    const token = noteRemoteSessionSyncStarted('rs1');
    noteRemoteSessionSyncCompleted('rs1', token);
    expect(deviceLinkInvokeMock).toHaveBeenCalledWith(
      'dev1',
      'notification:clear-session-attention',
      ['rs1', 'passive'],
    );
  });

  it('explicit receipts release on display-ready without waiting for a fresh sync', () => {
    // explicit 的证据来自触发源(用户处置横幅 / 显式操作),且 explicit 之后未必
    // 再有 sync——若也卡新鲜度会饿死。
    seedRemote();
    setRemoteReceiptDisplayReady('rs1', true);

    clearSystemSessionAttention('rs1', 'explicit');

    expect(deviceLinkInvokeMock).toHaveBeenCalledWith(
      'dev1',
      'notification:clear-session-attention',
      ['rs1', 'explicit'],
    );
  });

  it('preserves explicit receipts across a temporarily missing origin window', () => {
    // relay 重连 / bootstrap 窗口:remoteProjectsStore 暂清 sessionId→deviceId 映射,
    // 但视图靠 sticky remoteDeviceId 仍在展示(ready=true)。此时的 explicit 回执
    // 必须入队保留,origin 回来后由 flush 触发点补发,不得当成本机会话丢弃。
    seedRemote();
    setRemoteReceiptDisplayReady('rs1', true);
    remoteProjectsStore.setDeviceSessions('dev1', 'Dev', []); // origin 暂缺

    clearSystemSessionAttention('rs1', 'explicit');
    expect(deviceLinkInvokeMock).not.toHaveBeenCalled(); // 挂起而非丢弃

    seedRemote(); // origin 回来
    clearSystemSessionAttention('rs1', 'passive'); // 任一 flush 触发点
    expect(deviceLinkInvokeMock).toHaveBeenCalledTimes(1);
    expect(deviceLinkInvokeMock).toHaveBeenCalledWith(
      'dev1',
      'notification:clear-session-attention',
      ['rs1', 'explicit'],
    );
  });

  it('restores explicit receipts to the queue when the tunnel fails transiently', async () => {
    // 设备离线时 explicit 出队发送、重试耗尽:必须恢复入队而非吞掉——用户处置横幅
    // 只发一次,error 免疫又挡住后续 passive,丢了 host 红点就永挂。
    vi.useFakeTimers();
    try {
      seedRemote();
      setRemoteReceiptDisplayReady('rs1', true);
      deviceLinkInvokeMock.mockRejectedValue(new Error('[DEVICE_OFFLINE] target offline'));

      clearSystemSessionAttention('rs1', 'explicit');
      await vi.advanceTimersByTimeAsync(30_000); // 走完全部退避重试
      expect(deviceLinkInvokeMock.mock.calls.length).toBeGreaterThanOrEqual(2);

      deviceLinkInvokeMock.mockClear();
      deviceLinkInvokeMock.mockResolvedValue(undefined as never);
      // 重连后的任一 flush 触发点(这里用 sync 完成)补发恢复的 explicit。
      noteRemoteSessionSyncCompleted('rs1', noteRemoteSessionSyncStarted('rs1'));
      expect(deviceLinkInvokeMock).toHaveBeenCalledWith(
        'dev1',
        'notification:clear-session-attention',
        ['rs1', 'explicit'],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('explicit receipts never wait on sync freshness (no display-sourced tier)', () => {
    // 2026-07 统一:曾有第三档 'explicit-display'(banner 在视图内驻留即回执),
    // 连带一套 releaseGen 对账门槛确认「展示的不是复访缓存的旧错误」。红点改成未处理
    // 告警的派生投影后,展示不再产生已读,该档失去全部触发源已删除 —— 现在 explicit
    // 只来自用户处置动作,一律 origin 可解析即发,不卡任何新鲜度门槛。
    seedRemote();
    setRemoteReceiptDisplayReady('rs1', true);
    // 有在飞 sync 也不影响:explicit 不看放行代。
    noteRemoteSessionSyncStarted('rs1');

    clearSystemSessionAttention('rs1', 'explicit');
    expect(deviceLinkInvokeMock).toHaveBeenCalledWith(
      'dev1',
      'notification:clear-session-attention',
      ['rs1', 'explicit'],
    );
  });

  it('downgrades stale explicit receipts when new unread arrives while pending', () => {
    // explicit 只覆盖到用户动作那一刻:挂起(此处 origin 暂缺)期间被控端产生新
    // 未读,旧 explicit 降级为 passive 重新走门槛,不得清掉用户没见过的新内容。
    seedRemote();
    setRemoteReceiptDisplayReady('rs1', true);
    remoteProjectsStore.setDeviceSessions('dev1', 'Dev', []); // origin 暂缺 → 挂起

    clearSystemSessionAttention('rs1', 'explicit'); // action 类,入队时无未读
    expect(deviceLinkInvokeMock).not.toHaveBeenCalled();

    // 新未读上升沿 → 旧 explicit 降级 passive。
    applyRemoteSessionActivity('dev1', {
      sessionId: 'rs1',
      phase: 'completed',
      attention: true,
      compactDetail: '',
    });

    seedRemote(); // origin 回来
    // passive 门槛齐备(ready + 新一代 sync + 非 error)后才以 passive 发出。
    noteRemoteSessionSyncCompleted('rs1', noteRemoteSessionSyncStarted('rs1'));
    expect(deviceLinkInvokeMock).toHaveBeenCalledTimes(1);
    expect(deviceLinkInvokeMock).toHaveBeenCalledWith(
      'dev1',
      'notification:clear-session-attention',
      ['rs1', 'passive'],
    );
    removeRemoteSessionActivityEntry('rs1');
  });

  it('aborts in-flight retries when new unread arrives, then re-queues as passive', async () => {
    // 出队后退避重试期间被控端产生新未读:下一次尝试前中止旧回执(不得清掉新未读),
    // 按降级语义重新入队为 passive。
    vi.useFakeTimers();
    try {
      seedRemote();
      setRemoteReceiptDisplayReady('rs1', true);
      deviceLinkInvokeMock.mockRejectedValue(new Error('[DEVICE_OFFLINE] target offline'));

      clearSystemSessionAttention('rs1', 'explicit'); // action 类直发 → 首次尝试失败进退避
      expect(deviceLinkInvokeMock).toHaveBeenCalledTimes(1);

      // 退避窗口内新未读上升沿(era 递增)。
      applyRemoteSessionActivity('dev1', {
        sessionId: 'rs1',
        phase: 'completed',
        attention: true,
        compactDetail: '',
      });
      deviceLinkInvokeMock.mockClear();
      deviceLinkInvokeMock.mockResolvedValue(undefined as never);
      await vi.advanceTimersByTimeAsync(30_000); // 走完剩余退避:尝试前核对 era → 中止
      expect(deviceLinkInvokeMock).not.toHaveBeenCalled(); // 旧 explicit 未被重试发出

      // 降级后的 passive 走完整门槛(ready + 新一代 sync + 非 error)后放行。
      noteRemoteSessionSyncCompleted('rs1', noteRemoteSessionSyncStarted('rs1'));
      expect(deviceLinkInvokeMock).toHaveBeenCalledWith(
        'dev1',
        'notification:clear-session-attention',
        ['rs1', 'passive'],
      );
      removeRemoteSessionActivityEntry('rs1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the terminal-error probe when the activity mirror is missing', () => {
    // 活动镜像缺条目(推送丢失 / 未达)时,error 免疫回落消息层探针:探到终止错误
    // 同样按住 passive,等 explicit 升级。
    seedRemote();
    setRemoteReceiptDisplayReady('rs1', true);
    setRemoteTerminalErrorProbe(() => true);
    try {
      clearSystemSessionAttention('rs1', 'passive');
      noteRemoteSessionSyncCompleted('rs1', noteRemoteSessionSyncStarted('rs1'));
      expect(deviceLinkInvokeMock).not.toHaveBeenCalled();

      clearSystemSessionAttention('rs1', 'explicit');
      expect(deviceLinkInvokeMock).toHaveBeenCalledWith(
        'dev1',
        'notification:clear-session-attention',
        ['rs1', 'explicit'],
      );
    } finally {
      setRemoteTerminalErrorProbe(null);
    }
  });

  it('withholds passive receipts while the host session shows unread error', () => {
    seedRemote();
    setRemoteReceiptDisplayReady('rs1', true);
    applyRemoteSessionActivity('dev1', {
      sessionId: 'rs1',
      phase: 'error',
      attention: true,
      compactDetail: '',
    });

    clearSystemSessionAttention('rs1', 'passive');
    noteRemoteSessionSyncCompleted('rs1', noteRemoteSessionSyncStarted('rs1'));
    // error 未读对 passive 免疫(打过去会先清被控端 Dock 角标)。
    expect(deviceLinkInvokeMock).not.toHaveBeenCalled();

    // explicit(报错 UI 真实展示)把挂起 intent 升级后立即放行。
    clearSystemSessionAttention('rs1', 'explicit');
    expect(deviceLinkInvokeMock).toHaveBeenCalledWith(
      'dev1',
      'notification:clear-session-attention',
      ['rs1', 'explicit'],
    );

    removeRemoteSessionActivityEntry('rs1');
  });

  it('a sync already in flight at enqueue time does not release the receipt', () => {
    seedRemote();
    setRemoteReceiptDisplayReady('rs1', true);

    const inflight = noteRemoteSessionSyncStarted('rs1');
    clearSystemSessionAttention('rs1', 'passive');
    noteRemoteSessionSyncCompleted('rs1', inflight);
    // 入队前启动的 sync 数据可能早于触发事件 → 不放行。
    expect(deviceLinkInvokeMock).not.toHaveBeenCalled();

    const fresh = noteRemoteSessionSyncStarted('rs1');
    noteRemoteSessionSyncCompleted('rs1', fresh);
    expect(deviceLinkInvokeMock).toHaveBeenCalledTimes(1);
    expect(deviceLinkInvokeMock).toHaveBeenCalledWith(
      'dev1',
      'notification:clear-session-attention',
      ['rs1', 'passive'],
    );
  });

  it('explicit receipts bypass display-ready (mark-read targets unopened sessions); passive stays gated', () => {
    seedRemote();

    // 未打开会话(无 display-ready)的显式标已读:RunHistoryPane / 自动化菜单
    // 「全部标为已读」——必须立即送达,否则永远等不到 display-ready。
    clearSystemSessionAttention('rs1', 'explicit');
    expect(deviceLinkInvokeMock).toHaveBeenCalledTimes(1);
    expect(deviceLinkInvokeMock).toHaveBeenCalledWith(
      'dev1',
      'notification:clear-session-attention',
      ['rs1', 'explicit'],
    );

    // passive 三道门槛(display-ready / 新鲜 sync / error 免疫)不变:无 ready 时
    // 即使有新鲜 sync 也挂起,ready 落地才放。
    deviceLinkInvokeMock.mockClear();
    clearSystemSessionAttention('rs1', 'passive');
    noteRemoteSessionSyncCompleted('rs1', noteRemoteSessionSyncStarted('rs1'));
    expect(deviceLinkInvokeMock).not.toHaveBeenCalled();

    setRemoteReceiptDisplayReady('rs1', true);
    expect(deviceLinkInvokeMock).toHaveBeenCalledTimes(1);
    expect(deviceLinkInvokeMock).toHaveBeenCalledWith(
      'dev1',
      'notification:clear-session-attention',
      ['rs1', 'passive'],
    );
    setRemoteReceiptDisplayReady('rs1', false);
  });
});
