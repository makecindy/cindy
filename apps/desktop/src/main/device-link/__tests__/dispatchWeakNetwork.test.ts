/**
 * dispatchWeakNetwork.test.ts — 被控端弱网收尾行为契约。
 * -------------------------------------------------------------------------
 * 三条不变量(2026-08-03 弱网实测暴露):
 *  1. link-accept 发送失败(WS 背压)不再静默放弃:短退避有限重试,重试前
 *     复验开关/连接,成功才提交订阅;耗尽/断线/新 open 都会终止旧重试。
 *  2. invoke-result outbox 在 relay 离线期间不自旋:不 trySend、不刷日志,
 *     只做慢速 TTL 出清;ws-online 事件触发立即投递。
 *  3. outbox 条目保留时长按 channel 的控制端等待预算收窄(×2,封顶全局
 *     120s):控制端早已超时放弃的回包不再白占两分钟配额。
 * mock 面与 dispatchSendSafety.test.ts 一致:只 mock electron + settings。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeviceLinkError, INVOKE_TIMEOUT_OVERRIDES_MS } from '@cindy/device-link';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/xdt-maker-test/app',
    getPath: () => '/tmp/xdt-maker-test',
    getVersion: () => '0.0.0-test',
  },
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
const deviceLinkSettings = vi.hoisted(() => ({
  value: {
    remoteControlEnabled: true,
    revokedControllers: [] as string[],
  },
}));

vi.mock('../settings-store', () => ({
  readDeviceLinkSettings: () => deviceLinkSettings.value,
}));

import { __testing, flushRemoteInvokeResultOutboxOnReconnect } from '../dispatch';

function mkClient(
  over: Partial<{
    getStatus: ReturnType<typeof vi.fn>;
    sendInvokeResult: ReturnType<typeof vi.fn>;
    sendLinkAccept: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    getStatus: over.getStatus ?? vi.fn(() => 'online'),
    sendInvokeResult: over.sendInvokeResult ?? vi.fn(),
    sendLinkAccept: over.sendLinkAccept ?? vi.fn(),
    closeLink: vi.fn(),
    onFrame: vi.fn(),
    sendPush: vi.fn(),
  };
}

const backpressure = () => new DeviceLinkError('BACKPRESSURE', 'websocket send buffer is full');
const notConnected = () => new DeviceLinkError('NOT_CONNECTED', 'not connected to relay');

beforeEach(() => {
  vi.useFakeTimers();
  deviceLinkSettings.value = {
    remoteControlEnabled: true,
    revokedControllers: [],
  };
  __testing.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('[1] link-accept 发送失败的有限重试', () => {
  it('背压首发失败 → 不提交订阅;500ms 重试成功后才提交', () => {
    const sendLinkAccept = vi.fn().mockImplementationOnce(() => {
      throw backpressure();
    });
    const client = mkClient({ sendLinkAccept });
    __testing.setActiveClient(client as never);

    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-1', undefined);
    expect(sendLinkAccept).toHaveBeenCalledTimes(1);
    // 失败即返回:订阅未提交(幽灵订阅防护),留下一个待触发的重试
    expect(__testing.getActiveControllers()).toHaveLength(0);
    expect(__testing.pendingLinkAcceptRetryCount()).toBe(1);

    vi.advanceTimersByTime(500);
    expect(sendLinkAccept).toHaveBeenCalledTimes(2);
    expect(sendLinkAccept).toHaveBeenLastCalledWith('ctrl-a', 'open-1', expect.anything());
    // 第二次成功:订阅提交,无遗留重试
    expect(__testing.getActiveControllers().map((c) => c.deviceId)).toEqual(['ctrl-a']);
    expect(__testing.pendingLinkAcceptRetryCount()).toBe(0);
  });

  it('持续背压:按 500ms/1s/2s 重试三次后放弃,回到「等控制端重开」', () => {
    const sendLinkAccept = vi.fn(() => {
      throw backpressure();
    });
    const client = mkClient({ sendLinkAccept });
    __testing.setActiveClient(client as never);

    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-1', undefined);
    expect(sendLinkAccept).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(sendLinkAccept).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1_000);
    expect(sendLinkAccept).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(2_000);
    expect(sendLinkAccept).toHaveBeenCalledTimes(4);
    // 耗尽:不再有排期
    expect(__testing.pendingLinkAcceptRetryCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(sendLinkAccept).toHaveBeenCalledTimes(4);
    expect(__testing.getActiveControllers()).toHaveLength(0);
  });

  it('重试等待期间新 link-open 到达:旧重试被顶掉,只按新 requestId 回 accept', () => {
    const sendLinkAccept = vi
      .fn()
      .mockImplementationOnce(() => {
        throw backpressure();
      });
    const client = mkClient({ sendLinkAccept });
    __testing.setActiveClient(client as never);

    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-old', undefined);
    expect(__testing.pendingLinkAcceptRetryCount()).toBe(1);
    // 控制端超时重发:新 requestId 立即处理成功
    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-new', undefined);
    expect(sendLinkAccept).toHaveBeenLastCalledWith('ctrl-a', 'open-new', expect.anything());
    expect(__testing.pendingLinkAcceptRetryCount()).toBe(0);
    // 旧重试不再触发
    vi.advanceTimersByTime(10_000);
    expect(sendLinkAccept).toHaveBeenCalledTimes(2);
  });

  it('重试触发时 relay 已断线 / 开关已关闭:放弃,不发 accept', () => {
    // 首发路径不查询连接状态;第一次 getStatus 调用发生在重试回调的世代校验里
    const getStatus = vi.fn(() => 'connecting');
    const sendLinkAccept = vi.fn(() => {
      throw backpressure();
    });
    const client = mkClient({ sendLinkAccept, getStatus: getStatus as never });
    __testing.setActiveClient(client as never);
    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-1', undefined);
    expect(sendLinkAccept).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500); // 触发时 getStatus() = 'connecting' → 放弃
    expect(sendLinkAccept).toHaveBeenCalledTimes(1);

    // 开关关闭场景:重试走完整 handleLinkOpen,复验后拒绝
    __testing.reset();
    const sendLinkAccept2 = vi.fn(() => {
      throw backpressure();
    });
    const client2 = mkClient({ sendLinkAccept: sendLinkAccept2 });
    __testing.setActiveClient(client2 as never);
    __testing.handleLinkOpen(client2 as never, 'ctrl-b', 'open-2', undefined);
    deviceLinkSettings.value = { remoteControlEnabled: false, revokedControllers: [] };
    vi.advanceTimersByTime(500);
    expect(sendLinkAccept2).toHaveBeenCalledTimes(1); // 复验失败,不再尝试发送
  });
});

describe('[2] outbox 离线不自旋,上线事件驱动投递', () => {
  it('relay 离线期间 flush 不 trySend;ws-online 触发立即投递', () => {
    let status = 'connecting';
    const sendInvokeResult = vi.fn().mockImplementationOnce(() => {
      throw notConnected();
    });
    const client = mkClient({
      sendInvokeResult,
      getStatus: vi.fn(() => status) as never,
    });
    __testing.setActiveClient(client as never);

    // 首发失败入 outbox(此时 relay 离线)
    expect(
      __testing.sendInvokeResultSafe(
        client as never,
        'ctrl-a',
        'req-1',
        { ok: true, result: 1 },
        'local-db:sessions:list',
      ),
    ).toBe(true);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1);
    expect(sendInvokeResult).toHaveBeenCalledTimes(1);

    // 离线期间多轮慢扫描:不再尝试发送(无 NOT_CONNECTED 自旋)
    vi.advanceTimersByTime(20_000);
    expect(sendInvokeResult).toHaveBeenCalledTimes(1);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1);

    // 上线事件:立即投递成功
    status = 'online';
    flushRemoteInvokeResultOutboxOnReconnect();
    expect(sendInvokeResult).toHaveBeenCalledTimes(2);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(0);
  });
});

describe('[3] outbox 保留时长按 channel 收窄', () => {
  it('锁「预算 ×2、封顶 120s」联动:表内 channel 跟随共享表,缺省 30s→60s', () => {
    // 联动语义从共享表推导,不再硬编码结果值——此断言曾在 #1418/#1477 并行开发
    // 时写死 60s(当时表里还没有 listing 条目),两 PR 各自 CI 都绿、先后合入后
    // main 变红。表值本身(12s/60s)在下面单独锁定:它们是产品决策,变更时红在
    // 这里提醒显式确认;而「×2 封顶」的联动对表变更免疫。
    const listingBudget = INVOKE_TIMEOUT_OVERRIDES_MS['local-db:sessions:list'];
    const worktreeBudget = INVOKE_TIMEOUT_OVERRIDES_MS['worktree:create'];
    expect(listingBudget).toBe(12_000);
    expect(worktreeBudget).toBe(60_000);
    expect(__testing.outboxEntryMaxAgeMs('local-db:sessions:list')).toBe(
      Math.min(listingBudget * 2, 120_000),
    );
    expect(__testing.outboxEntryMaxAgeMs(undefined)).toBe(60_000);
    expect(__testing.outboxEntryMaxAgeMs('worktree:create')).toBe(
      Math.min(worktreeBudget * 2, 120_000),
    );
  });

  it('离线慢扫描按逐条 TTL 出清:listing(24s 档)先被丢,长任务 channel 保留到 120s', () => {
    const sendInvokeResult = vi.fn(() => {
      throw notConnected();
    });
    const client = mkClient({
      sendInvokeResult,
      getStatus: vi.fn(() => 'connecting') as never,
    });
    __testing.setActiveClient(client as never);
    __testing.sendInvokeResultSafe(
      client as never,
      'ctrl-a',
      'req-listing',
      { ok: true, result: 1 },
      'local-db:sessions:list',
    );
    __testing.sendInvokeResultSafe(
      client as never,
      'ctrl-a',
      'req-worktree',
      { ok: true, result: 2 },
      'worktree:create',
    );
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(2);

    vi.advanceTimersByTime(61_000);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1); // listing 出清,worktree 保留

    vi.advanceTimersByTime(60_000);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(0); // 121s:worktree 也到期
  });
});
