/**
 * notificationService.test.ts
 * ---------------------------------------------------------------------------
 * 钉死 IPC `notification:show-session-event` 的 channels 分发契约:
 *   1. payload.channels 缺省 → 只走桌面 toast (防御未来新增 invoke 调用方
 *      误以为 channels 必填; 当前唯一 invoke 调用方 CCAgentSidebarUpper.tsx
 *      总是显式传 channels)
 *   2. { desktop:true, feishu:false } → 同上
 *   3. { desktop:false, feishu:true } → 不弹 toast,只发飞书
 *   4. { desktop:true, feishu:true } → 两条都走
 *   5. feishu:true 但 ownerOpenId === null → 不调 sendMarkdownText,只 warn
 *   6. sendMarkdownText 抛错 → handler 不冒泡 (resolve),不影响桌面分支
 *
 * 主要回归风险:
 *   - 改坏 channels 兼容性默认 → 后续任何不传 channels 的调用方会静默失效
 *   - 飞书分支抛错冒泡 → renderer invoke 会 reject,污染调用方
 *
 * Scheduler 不经过这个 IPC handler，而是直接调用导出的 main 进程入口；
 * 它的终态映射由 scheduler-host/__tests__/notifier.test.ts 单独覆盖。
 *
 * mock 策略参考 lifecycle.test.ts: vi.mock('electron') 喂最小桩;
 * Notification 的实例方法和 isSupported 必须支持(constructor 是顶层 IIFE 触发)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type IpcHandler = (event: unknown, payload: unknown) => Promise<void> | void;

// 捕获被注册的 IPC handlers。每个用例 freshModule 后重置。
const registeredHandlers = new Map<string, IpcHandler>();

// Notification 构造调用计数(每条 toast 一次)。
const notificationCtor = vi.fn();
// Notification.isSupported() — 默认 true; 单独用例需改成 false 时,setMock 之前覆盖。
let notificationSupported = true;

/**
 * Fake Notification 桩:
 *   - constructor 计数,验通道分发
 *   - on('close', cb) / on('click', cb) 缓存 cb,show() 时同步触发 close 让
 *     被测代码里的 `liveNotifications` Set 释放,避免后续如果加"同 module 多
 *     invoke"的用例时 Set 无限增长
 */
class FakeNotification {
  private closeCb?: () => void;
  constructor(opts: unknown) {
    notificationCtor(opts);
  }
  on(evt: string, cb: (...args: unknown[]) => void): this {
    if (evt === 'close') this.closeCb = cb;
    return this;
  }
  show(): void {
    // 真实场景里 close 是 OS toast 消失后异步触发的,这里同步 fire 一下就够,
    // 单纯让 main 代码里 liveNotifications.delete(notif) 跑到。
    queueMicrotask(() => this.closeCb?.());
  }
}

vi.mock('electron', () => ({
  app: {
    // 顶层 IIFE 里读 app.isPackaged 决定 devNotificationIcon;
    // 选 true → 不走 nativeImage 那条路径,免去 fs 依赖。
    isPackaged: true,
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      registeredHandlers.set(channel, handler);
    },
  },
  Notification: Object.assign(FakeNotification, {
    isSupported: () => notificationSupported,
  }),
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
  },
}));

// 安静化 logger,同时给某些用例验 warn 调用次数。
const warn = vi.fn();
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn,
    error: vi.fn(),
  }),
}));

const markSessionNeedsAttention = vi.fn();
vi.mock('../appBadgeService', () => ({
  markSessionNeedsAttention,
}));

// mobile 通道:真实实现在 device-link host(依赖 electron/ws/authManager 全家桶),
// 这里只验分发契约 —— channels.mobile === true 才调用。
const sendMobileSessionNotify = vi.fn(() => true);
// 链路代次:handler 在任何 await 之前捕获并随 payload 透传(真实的过期丢弃逻辑在
// device-link 侧,这里只验「捕获时机 + 透传」契约)。
const getMobileNotifyGeneration = vi.fn(() => 7);
vi.mock('../device-link', () => ({
  sendMobileSessionNotify,
  getMobileNotifyGeneration,
}));

// mobile 正文素材:最近一条 assistant 内容(真实实现走 localDb)。默认空 = 无摘要,
// 既有用例的调用断言不带 detail;内容用例单独 mockResolvedValueOnce。
const latestMessageText = vi.fn(async (_sessionId: string, _role: string) => '');
vi.mock('../localDb/latestMessageText', () => ({
  latestMessageText: (sessionId: string, role: string) => latestMessageText(sessionId, role),
}));
const drainPersistQueue = vi.fn((): Promise<void> => Promise.resolve());
vi.mock('../messagePersistBroadcaster', () => ({
  drainPersistQueue: () => drainPersistQueue(),
}));

interface FakeFeishuIM {
  getOwnerOpenId: ReturnType<typeof vi.fn>;
  sendMarkdownText: ReturnType<typeof vi.fn>;
}

function makeFeishuIm(ownerOpenId: string | null): FakeFeishuIM {
  return {
    getOwnerOpenId: vi.fn(() => ownerOpenId),
    sendMarkdownText: vi.fn(async () => ({ messageId: 'msg-1' })),
  };
}

// notificationService 在顶层做 IIFE / module state, 每个用例都拿一份新的。
async function freshService() {
  vi.resetModules();
  registeredHandlers.clear();
  notificationCtor.mockClear();
  warn.mockClear();
  notificationSupported = true;
  markSessionNeedsAttention.mockClear();
  sendMobileSessionNotify.mockClear();
  getMobileNotifyGeneration.mockClear();
  latestMessageText.mockClear();
  drainPersistQueue.mockClear();
  return import('../notificationService');
}

async function invokeHandler(payload: unknown): Promise<void> {
  const handler = registeredHandlers.get('notification:show-session-event');
  if (!handler) throw new Error('handler not registered');
  await handler({} as unknown, payload);
}

/** mobile 分支是 fire-and-forget 的独立 async 块;断言它之前先把微任务队列排空。 */
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const baseDeps = (feishuIm: FakeFeishuIM) => ({
  getWindow: () => null,
  // 实参在主进程是 FeishuIM, 测试里用结构兼容的 fake 就够 — 仅访问
  // getOwnerOpenId / sendMarkdownText 两个方法。
  feishuIm: feishuIm as unknown as Parameters<
    Awaited<ReturnType<typeof freshService>>['initNotificationService']
  >[0]['feishuIm'],
});

describe('notificationService — channels 分发', () => {
  beforeEach(() => {
    // 每个用例重新注册 handler,避免相互污染。
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('同步并校验 renderer 持久化的桌面通知总开关', async () => {
    const { getDesktopNotificationsEnabled, initNotificationService } = await freshService();
    initNotificationService(baseDeps(makeFeishuIm('ou_owner')));
    const handler = registeredHandlers.get('notification:set-desktop-enabled');
    expect(handler).toBeDefined();

    await handler?.({}, false);
    expect(getDesktopNotificationsEnabled()).toBe(false);
    expect(() => handler?.({}, 'false')).toThrow(
      'notification desktop enabled must be a boolean',
    );
  });

  it('payload.channels 缺省 → 仅桌面 toast (默认契约,防御漏传)', async () => {
    const { initNotificationService } = await freshService();
    const feishuIm = makeFeishuIm('ou_owner');
    initNotificationService(baseDeps(feishuIm));

    await invokeHandler({ sessionId: 's1', title: 'Hello', kind: 'done' });

    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(markSessionNeedsAttention).toHaveBeenCalledWith('s1');
    expect(feishuIm.sendMarkdownText).not.toHaveBeenCalled();
    expect(sendMobileSessionNotify).not.toHaveBeenCalled();
  });

  it('payload 运行时校验:非法 kind / 超长 title / 空 sessionId 直接 reject,不进任何通道', async () => {
    const { initNotificationService } = await freshService();
    const feishuIm = makeFeishuIm('ou_owner');
    initNotificationService(baseDeps(feishuIm));

    const invalids = [
      { sessionId: '', title: 'x', kind: 'done' },
      { sessionId: 's1', title: 'x', kind: 'pwned' },
      { sessionId: 's1', title: 'x'.repeat(1025), kind: 'done' },
      { sessionId: 's1', title: 'x', kind: 'done', channels: 'all' },
      null,
    ];
    for (const payload of invalids) {
      await expect(invokeHandler(payload)).rejects.toThrow('invalid session event payload');
    }
    expect(notificationCtor).not.toHaveBeenCalled();
    expect(sendMobileSessionNotify).not.toHaveBeenCalled();
    expect(markSessionNeedsAttention).not.toHaveBeenCalled();
  });

  it('mobile 通道同步抛错不 reject invoke,飞书分支照常执行', async () => {
    const { initNotificationService } = await freshService();
    const feishuIm = makeFeishuIm('ou_owner');
    initNotificationService(baseDeps(feishuIm));
    sendMobileSessionNotify.mockImplementationOnce(() => {
      throw new Error('ws send failed');
    });

    await expect(
      invokeHandler({
        sessionId: 's1',
        title: 'Hello',
        kind: 'done',
        channels: { desktop: false, feishu: true, mobile: true },
      }),
    ).resolves.toBeUndefined();
    expect(feishuIm.sendMarkdownText).toHaveBeenCalledTimes(1);
    // 把 fire-and-forget 块跑完:消费掉 mockImplementationOnce 的抛错,不泄漏到后续用例。
    await flushAsync();
    expect(sendMobileSessionNotify).toHaveBeenCalledTimes(1);
  });

  it('持久化队列挂死时不阻塞 invoke 与飞书分支(mobile 摘要 fire-and-forget)', async () => {
    const { initNotificationService } = await freshService();
    const feishuIm = makeFeishuIm('ou_owner');
    initNotificationService(baseDeps(feishuIm));
    // 队列 pending 不 resolve —— 模拟别的会话慢写入长期占住全局队列。
    drainPersistQueue.mockReturnValueOnce(new Promise<void>(() => {}));

    await expect(
      invokeHandler({
        sessionId: 's1',
        title: 'Hello',
        kind: 'done',
        channels: { desktop: false, feishu: true, mobile: true },
      }),
    ).resolves.toBeUndefined();
    expect(feishuIm.sendMarkdownText).toHaveBeenCalledTimes(1);
    // mobile 发送仍卡在队列上,不应已触发
    await flushAsync();
    expect(sendMobileSessionNotify).not.toHaveBeenCalled();
  });

  it('channels.mobile === true → 调用手机推送分发(标题兜底后的 safeTitle)', async () => {
    const { initNotificationService } = await freshService();
    const feishuIm = makeFeishuIm('ou_owner');
    initNotificationService(baseDeps(feishuIm));

    await invokeHandler({
      sessionId: 's1',
      title: 'Hello',
      kind: 'needs-reply',
      channels: { desktop: false, feishu: false, mobile: true },
    });

    await flushAsync();
    expect(sendMobileSessionNotify).toHaveBeenCalledWith({
      sessionId: 's1',
      title: 'Hello',
      kind: 'needs-reply',
      generation: 7,
    });
    expect(notificationCtor).not.toHaveBeenCalled();
    expect(feishuIm.sendMarkdownText).not.toHaveBeenCalled();
    // 桌面/飞书都关时 mobile 通道仍走,且角标照常标记
    expect(markSessionNeedsAttention).toHaveBeenCalledWith('s1');
  });

  it('mobile 正文带最近 assistant 内容;error 终态不取(无可靠错误正文来源)', async () => {
    const { initNotificationService } = await freshService();
    initNotificationService(baseDeps(makeFeishuIm('ou_owner')));

    latestMessageText.mockResolvedValueOnce('修好了,共改了 3 个文件。');
    await invokeHandler({
      sessionId: 's1',
      title: 'Hello',
      kind: 'done',
      channels: { desktop: false, feishu: false, mobile: true },
    });
    await flushAsync();
    expect(sendMobileSessionNotify).toHaveBeenCalledWith({
      sessionId: 's1',
      title: 'Hello',
      kind: 'done',
      generation: 7,
      detail: '修好了,共改了 3 个文件。',
    });

    sendMobileSessionNotify.mockClear();
    latestMessageText.mockClear();
    await invokeHandler({
      sessionId: 's1',
      title: 'Hello',
      kind: 'error',
      channels: { desktop: false, feishu: false, mobile: true },
    });
    await flushAsync();
    expect(latestMessageText).not.toHaveBeenCalled();
    expect(sendMobileSessionNotify).toHaveBeenCalledWith({
      sessionId: 's1',
      title: 'Hello',
      kind: 'error',
      generation: 7,
    });
  });

  it('链路代次在 await 之前捕获:等待队列期间换号,透传的仍是发起时的代次', async () => {
    const { initNotificationService } = await freshService();
    initNotificationService(baseDeps(makeFeishuIm('ou_owner')));
    // 发起时代次 1;drain 结束后(模拟登出/换号已发生)当前代次已是 7(默认实现)。
    getMobileNotifyGeneration.mockReturnValueOnce(1);

    await invokeHandler({
      sessionId: 's1',
      title: 'Hello',
      kind: 'done',
      channels: { desktop: false, feishu: false, mobile: true },
    });
    await flushAsync();
    expect(sendMobileSessionNotify).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 1 }),
    );
  });

  it('{ desktop:true, feishu:false } → 仅桌面 toast', async () => {
    const { initNotificationService } = await freshService();
    const feishuIm = makeFeishuIm('ou_owner');
    initNotificationService(baseDeps(feishuIm));

    await invokeHandler({
      sessionId: 's1',
      title: 'Hello',
      kind: 'done',
      channels: { desktop: true, feishu: false },
    });

    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Cindy · Hello',
        body: '已完成 ✓',
      }),
    );
    expect(feishuIm.sendMarkdownText).not.toHaveBeenCalled();
  });

  it('needs-reply kind → 桌面显示需要你回复并标识 Cindy', async () => {
    const { initNotificationService } = await freshService();
    const feishuIm = makeFeishuIm('ou_owner');
    initNotificationService(baseDeps(feishuIm));

    await invokeHandler({
      sessionId: 's1',
      title: 'Needs input',
      kind: 'needs-reply',
      channels: { desktop: true, feishu: false },
    });

    expect(notificationCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Cindy · Needs input',
        body: '需要你回复',
      }),
    );
  });

  it('{ desktop:false, feishu:true } → 仅飞书,不弹 toast', async () => {
    const { initNotificationService } = await freshService();
    const feishuIm = makeFeishuIm('ou_owner');
    initNotificationService(baseDeps(feishuIm));

    await invokeHandler({
      sessionId: 's1',
      title: 'Hello',
      kind: 'needs-reply',
      channels: { desktop: false, feishu: true },
    });

    expect(notificationCtor).not.toHaveBeenCalled();
    expect(feishuIm.sendMarkdownText).toHaveBeenCalledTimes(1);
    // 文案断言 — 锁住对外可见的飞书消息格式,后续如要改文案需主动调整测试。
    expect(feishuIm.sendMarkdownText).toHaveBeenCalledWith(
      'ou_owner',
      'Cindy · 会话「Hello」需要你回复',
    );
  });

  it('{ desktop:true, feishu:true } → 两条都走', async () => {
    const { initNotificationService } = await freshService();
    const feishuIm = makeFeishuIm('ou_owner');
    initNotificationService(baseDeps(feishuIm));

    await invokeHandler({
      sessionId: 's1',
      title: 'Hello',
      kind: 'done',
      channels: { desktop: true, feishu: true },
    });

    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(feishuIm.sendMarkdownText).toHaveBeenCalledTimes(1);
    expect(feishuIm.sendMarkdownText).toHaveBeenCalledWith(
      'ou_owner',
      'Cindy · 会话「Hello」已完成 ✓',
    );
  });

  it('error kind → 桌面与飞书都显示执行失败', async () => {
    const { initNotificationService } = await freshService();
    const feishuIm = makeFeishuIm('ou_owner');
    initNotificationService(baseDeps(feishuIm));

    await invokeHandler({
      sessionId: 's1',
      title: 'Broken model',
      kind: 'error',
      channels: { desktop: true, feishu: true },
    });

    expect(notificationCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Cindy · Broken model',
        body: '执行失败',
      }),
    );
    expect(feishuIm.sendMarkdownText).toHaveBeenCalledWith(
      'ou_owner',
      'Cindy · 会话「Broken model」执行失败',
    );
  });

  it('feishu:true 但 ownerOpenId === null → 不调 sendMarkdownText,warn 一次', async () => {
    const { initNotificationService } = await freshService();
    const feishuIm = makeFeishuIm(null);
    initNotificationService(baseDeps(feishuIm));

    await invokeHandler({
      sessionId: 's1',
      title: 'Hello',
      kind: 'done',
      channels: { desktop: false, feishu: true },
    });

    expect(feishuIm.sendMarkdownText).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('no bot owner bound');
  });

  it('sendMarkdownText 抛错 → handler 不冒泡,桌面分支仍触发', async () => {
    const { initNotificationService } = await freshService();
    const feishuIm = makeFeishuIm('ou_owner');
    feishuIm.sendMarkdownText.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { response: { status: 400, data: { code: 1 } } }),
    );
    initNotificationService(baseDeps(feishuIm));

    // 必须不 throw —— renderer 那侧 invoke 走 IPC, 抛错会变成 rejection 污染调用方。
    await expect(
      invokeHandler({
        sessionId: 's1',
        title: 'Hello',
        kind: 'done',
        channels: { desktop: true, feishu: true },
      }),
    ).resolves.toBeUndefined();

    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('feishu sendMarkdownText failed');
  });
});
