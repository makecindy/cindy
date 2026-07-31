/**
 * 手动重启阻断查询的授权边界。
 *
 * 这个 handler 读的是**全局**会话 / Claude / Ghost / scheduler 活动态。带 preload 的窗口被
 * 导航到不可信内容、WebView、子 frame 都能发 Electron IPC,不校验 sender 就等于把「本机现在
 * 在跑什么」暴露给它们。按 docs/dev-rules/electron-security-and-process-boundaries.md §5,
 * 新增 handler 不得以「旧代码没校验」为由省略 sender 验证 —— 这里把它钉住。
 *
 * 另一条要钉的:**断言必须发生在读取任何跟踪器之前**。先读后拦仍然会碰全局状态(也可能被
 * 时序侧信道观察到),所以拒绝路径下的来源读取次数必须是 0。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  trusted: true,
  reads: 0,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: () => {
    if (!h.trusted) throw new Error('[PERMISSION_DENIED] 此操作只能从 Cindy 主页面发起');
  },
}));

import {
  RELAUNCH_BLOCKING_ACTIVITY_CHANNEL,
  registerRelaunchBusyActivityIpc,
} from '../relaunchBusyActivityIpc.js';

/** 每个来源都记一次读取,用来证明拒绝路径下一个都没被碰。 */
function countingSources(busy: boolean) {
  return () => ({
    anySessionInTurn: (): boolean => { h.reads += 1; return busy; },
    listClaudeBackgroundSessions: (): readonly string[] => { h.reads += 1; return []; },
    anyGhostSessionBusy: (): boolean => { h.reads += 1; return false; },
    anySchedulerRunRunning: async (): Promise<boolean> => { h.reads += 1; return false; },
  });
}

/** handler 只把 event 交给 sender 断言(已被 mock),不读它的字段。 */
const fakeEvent = {} as never;

beforeEach(() => {
  h.handlers.clear();
  h.trusted = true;
  h.reads = 0;
});

describe('registerRelaunchBusyActivityIpc', () => {
  it('注册在约定的 channel 上', () => {
    registerRelaunchBusyActivityIpc(countingSources(false));
    expect(h.handlers.has(RELAUNCH_BLOCKING_ACTIVITY_CHANNEL)).toBe(true);
  });

  it('可信 sender:正常返回判定结果', async () => {
    registerRelaunchBusyActivityIpc(countingSources(true));
    const handler = h.handlers.get(RELAUNCH_BLOCKING_ACTIVITY_CHANNEL)!;
    await expect(handler(fakeEvent)).resolves.toBe(true);
    expect(h.reads).toBeGreaterThan(0);
  });

  it('不可信 sender(WebView / 子 frame / 未登记窗口):拒绝，且一个来源都不读', async () => {
    h.trusted = false;
    registerRelaunchBusyActivityIpc(countingSources(true));
    const handler = h.handlers.get(RELAUNCH_BLOCKING_ACTIVITY_CHANNEL)!;
    await expect(handler(fakeEvent)).rejects.toThrow('PERMISSION_DENIED');
    // 断言在读取之前 —— 拒绝路径下不该碰到任何全局跟踪器。
    expect(h.reads).toBe(0);
  });
});
