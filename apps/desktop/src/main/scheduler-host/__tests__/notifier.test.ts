import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { Schedule, ScheduleRun } from '@cindy/maker-scheduler';
import type { FeishuIM } from '@cindy/im';

import { showDesktopSessionEvent } from '../../notificationService';
import { sendMobileSessionNotify } from '../../device-link';
import { DesktopNotifier } from '../notifier';

vi.mock('../../notificationService', () => ({
  showDesktopSessionEvent: vi.fn(),
}));

// 手机推送真实实现在 device-link host(依赖 electron/ws 全家桶),这里只验分发。
vi.mock('../../device-link', () => ({
  getMobileNotifyGeneration: vi.fn(() => 7),
  sendMobileSessionNotify: vi.fn(() => true),
}));

const schedule = {
  id: 'schedule-1',
  name: '每日检查',
  notify: { desktop: true, feishu: false },
} as Schedule;

function run(status: ScheduleRun['status']): ScheduleRun {
  return {
    id: 'run-1',
    scheduleId: schedule.id,
    sessionId: 'session-1',
    firedAt: 1,
    finishedAt: 2,
    status,
  };
}

function createNotifier(opts?: {
  sendMarkdownText?: ReturnType<typeof vi.fn>;
  shouldNotifyDesktop?: () => boolean;
}): {
  notifier: DesktopNotifier;
  sendMarkdownText: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  const sendMarkdownText = opts?.sendMarkdownText ?? vi.fn(async () => ({ messageId: 'msg-1' }));
  const warn = vi.fn();
  const notifier = new DesktopNotifier({
    getMainWindow: () => null as BrowserWindow | null,
    feishuIm: {
      getOwnerOpenId: vi.fn(() => 'ou_owner'),
      sendMarkdownText,
    } as unknown as FeishuIM,
    logger: { warn },
    shouldNotifyDesktop: opts?.shouldNotifyDesktop ?? (() => true),
  });
  return { notifier, sendMarkdownText, warn };
}

describe('DesktopNotifier desktop status mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps a successful run to done', async () => {
    const { notifier } = createNotifier();

    await notifier.notify(schedule, run('success'));

    expect(showDesktopSessionEvent).toHaveBeenCalledWith(expect.any(Function), {
      sessionId: 'session-1',
      title: '每日检查',
      kind: 'done',
    });
  });

  it.each(['failed', 'aborted', 'interrupted'] as const)(
    'maps an incomplete %s run to error',
    async (status) => {
      const { notifier } = createNotifier();

      await notifier.notify(schedule, run(status));

      expect(showDesktopSessionEvent).toHaveBeenCalledWith(expect.any(Function), {
        sessionId: 'session-1',
        title: '每日检查',
        kind: 'error',
      });
    },
  );

  it('does not show a scheduler toast when the shared desktop gate is closed', async () => {
    const { notifier } = createNotifier({ shouldNotifyDesktop: () => false });

    await notifier.notify(schedule, run('success'));

    expect(showDesktopSessionEvent).not.toHaveBeenCalled();
    // 手机推送不受桌面开关影响(手机端自持开关;发送侧防打扰在 device-link 收口)
    expect(sendMobileSessionNotify).toHaveBeenCalledWith({
      sessionId: 'session-1',
      title: '每日检查',
      kind: 'done',
      // notify() 入口(任何 await 之前)捕获的链路代次,原样透传
      generation: 7,
    });
  });

  it('skips the mobile push when the run is not bound to a session', async () => {
    const { notifier } = createNotifier();

    await notifier.notify(schedule, { ...run('success'), sessionId: undefined });

    expect(sendMobileSessionNotify).not.toHaveBeenCalled();
  });

  it('mobile 正文带运行结果摘要:成功用 resultText,失败用 errorMsg', async () => {
    const { notifier } = createNotifier();

    await notifier.notify(schedule, { ...run('success'), resultText: '巡检完成,无异常。' });
    expect(sendMobileSessionNotify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'done', detail: '巡检完成,无异常。' }),
    );

    vi.mocked(sendMobileSessionNotify).mockClear();
    await notifier.notify(schedule, { ...run('failed'), errorMsg: '网络超时' });
    expect(sendMobileSessionNotify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', detail: '网络超时' }),
    );
  });

  it('respects the per-schedule opt-out: desktop 与 feishu 全关时 mobile 也不发', async () => {
    const { notifier } = createNotifier();
    const mutedSchedule = {
      ...schedule,
      notify: { desktop: false, feishu: false },
    } as Schedule;

    await notifier.notify(mutedSchedule, run('success'));

    expect(sendMobileSessionNotify).not.toHaveBeenCalled();
    expect(showDesktopSessionEvent).not.toHaveBeenCalled();
  });

  it('renders and sends a successful Feishu notification', async () => {
    const { notifier, sendMarkdownText } = createNotifier();
    const feishuSchedule = {
      ...schedule,
      notify: { desktop: false, feishu: true },
    } as Schedule;

    await notifier.notify(feishuSchedule, run('success'));

    expect(sendMarkdownText).toHaveBeenCalledWith(
      'ou_owner',
      expect.stringContaining('✅ **每日检查**'),
    );
  });

  it('swallows a Feishu send failure after logging it', async () => {
    const sendError = new Error('Feishu unavailable');
    const sendMarkdownText = vi.fn(async () => Promise.reject(sendError));
    const { notifier, warn } = createNotifier({ sendMarkdownText });
    const feishuSchedule = {
      ...schedule,
      notify: { desktop: false, feishu: true },
    } as Schedule;

    await expect(notifier.notify(feishuSchedule, run('failed'))).resolves.toBeUndefined();

    expect(sendMarkdownText).toHaveBeenCalledWith(
      'ou_owner',
      expect.stringContaining('❌ **每日检查**'),
    );
    expect(warn).toHaveBeenCalledWith('feishu notify failed', sendError);
  });
});
